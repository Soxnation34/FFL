// Which ratings and combine measurables drive RB rushing production?
// Three target metrics, matching the FOF8 box-score columns: Yards (Rushing_Yards/Game,
// a rate stat so workload doesn't dominate), Avg (yards per carry), and 10+R (10-Yard_Runs
// per carry — "breakaway/explosive run" rate).
//
// IMPORTANT DATA QUIRK DISCOVERED HERE (not previously documented): player_ratings_season
// (and therefore the Exhibition-stage snapshot baked into player_year_summary) is entirely
// zero/blank for every year before 2039 — 36 seasons (2003-2038) of RB stats exist with NO
// usable rating data alongside them. Years 2074 and 2076 are also blank (current-year/lag,
// consistent with the known 1-2 year export lag). Any ratings-vs-stats join MUST filter
// Current_Overall > 0 (not just IS NOT NULL — missing rows are stored as 0, not NULL) or it
// will silently pull in ~36 years of all-zero ratings and wreck every correlation.
//
// Methodology per cfl_ratings_stats_analysis_methodology: partial correlation controlling for
// Current_Overall, collinearity check among candidates, multiple regression with all ratings
// competing, Overall-excluded view, and an interaction stress-test before crediting any synergy.
// Usage: node scripts/rb_yards_avg_explosive_drivers.js
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'ffl.db'));

// RB-applicable skill ratings only (confirmed non-zero for RB rows once the year filter is
// applied; Courage/Adjust_to_Ball/Run_Blocking/Pass_Blocking etc. are 0% for RB and excluded).
const CANDIDATES = [
  'Speed', 'Power_Inside', 'Third-Down_Runs', 'Hole_Recognition', 'Elusiveness',
  'Speed_Outside', 'Blitz_Pickup', 'Avoid_Drops', 'Get_Downfield', 'Route_Running',
];
const jsKeys = CANDIDATES.map(c => c.replace(/[^A-Za-z0-9]/g, '_'));

function zscore(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return arr.map(v => (v - mean) / sd);
}
function pearson(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  return cov / Math.sqrt(vx * vy);
}
function partialCorr(rxy, rxz, ryz) {
  const denom = Math.sqrt((1 - rxz * rxz) * (1 - ryz * ryz));
  return denom === 0 ? null : (rxy - rxz * ryz) / denom;
}
function matInv(M) {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const pv = A[col][col];
    for (let c = 0; c < 2 * n; c++) A[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      for (let c = 0; c < 2 * n; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map(row => row.slice(n));
}
function ols(X, y) {
  const n = X.length, p = X[0].length;
  const XtX = Array.from({ length: p }, () => Array(p).fill(0));
  const Xty = Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const inv = matInv(XtX);
  const beta = inv.map(row => row.reduce((s, v, k) => s + v * Xty[k], 0));
  let ssr = 0, sst = 0;
  const ymean = y.reduce((a, b) => a + b, 0) / n;
  const fitted = X.map(row => row.reduce((s, v, k) => s + v * beta[k], 0));
  for (let i = 0; i < n; i++) { ssr += (y[i] - fitted[i]) ** 2; sst += (y[i] - ymean) ** 2; }
  const sigma2 = ssr / (n - p);
  const se = inv.map((row, i) => Math.sqrt(sigma2 * row[i]));
  const t = beta.map((b, i) => b / se[i]);
  return { beta, se, t, r2: 1 - ssr / sst };
}

// ============================================================================
// PART A — ratings drivers, year-by-year RB seasons (2039+, Current_Overall > 0)
// ============================================================================
const MIN_RUSHES = 20;
const cols = ['Player_ID', 'Year', 'Games_Played', 'Rushes', 'Rushing_Yards', '"10-Yard_Runs" AS TenPlusR', 'Current_Overall AS OA']
  .concat(CANDIDATES.map(c => `"${c}" AS ${c.replace(/[^A-Za-z0-9]/g, '_')}`));
const sql = `SELECT ${cols.join(', ')} FROM player_year_summary
             WHERE Position = 'RB' AND Current_Overall > 0 AND Games_Played >= 4 AND Rushes >= ${MIN_RUSHES}`;
const rows = db.prepare(sql).all();

console.log('='.repeat(78));
console.log(`PART A: RB RATINGS DRIVERS  (season-level, Year>=2039 implied by Current_Overall>0, n=${rows.length})`);
console.log('='.repeat(78));

// --- Collinearity check among the candidate ratings themselves (step 2 of methodology) ---
console.log('\nCollinearity among candidate RB ratings (pairwise r, |r|>=0.5 flagged):');
const rawRating = {}; for (const k of jsKeys) rawRating[k] = rows.map(r => r[k]);
for (let i = 0; i < jsKeys.length; i++) {
  for (let j = i + 1; j < jsKeys.length; j++) {
    const r = pearson(rawRating[jsKeys[i]], rawRating[jsKeys[j]]);
    if (Math.abs(r) >= 0.5) console.log(`  ${r >= 0 ? '+' : ''}${r.toFixed(3)}  ${jsKeys[i]} <-> ${jsKeys[j]}`);
  }
}

const OA = zscore(rows.map(r => r.OA));
const ratingZ = {}; for (const k of jsKeys) ratingZ[k] = zscore(rawRating[k]);

const metrics = [
  ['Yards / Game (Rushing_Yards / Games_Played)', rows.map(r => r.Rushing_Yards / r.Games_Played)],
  ['Avg (Rushing_Yards / Rushes)', rows.map(r => r.Rushing_Yards / r.Rushes)],
  ['10+R rate (10-Yard_Runs / Rushes)', rows.map(r => r.TenPlusR / r.Rushes)],
];

const survivors = {}; // for interaction stress test later: which ratings hold up per metric

for (const [metricName, metricArr] of metrics) {
  console.log(`\n${'-'.repeat(78)}\n${metricName}\n${'-'.repeat(78)}`);

  // 1) Solo partial correlation controlling only for Overall
  const partials = jsKeys.map(k => {
    const r = pearson(ratingZ[k], metricArr);
    const rxz = pearson(ratingZ[k], OA);
    const ryz = pearson(metricArr, OA);
    return { k, partial: partialCorr(r, rxz, ryz) };
  });
  partials.sort((a, b) => Math.abs(b.partial) - Math.abs(a.partial));
  console.log('Solo partial r (controlling only for Current_Overall):');
  for (const p of partials) console.log(`  ${p.partial >= 0 ? '+' : ''}${p.partial.toFixed(3)}  ${p.k}`);

  // 2) Multiple regression, all ratings + Overall competing together
  const Xwith = rows.map((_, i) => [1, OA[i], ...jsKeys.map(k => ratingZ[k][i])]);
  const mWith = ols(Xwith, metricArr);
  const labelsWith = ['intercept', 'Current_Overall', ...jsKeys];
  const coefsWith = labelsWith.map((l, i) => ({ l, beta: mWith.beta[i], t: mWith.t[i] })).slice(1);
  coefsWith.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  console.log(`\nMultiple regression, WITH Overall (R^2=${mWith.r2.toFixed(3)}):`);
  for (const c of coefsWith) {
    const sig = Math.abs(c.t) > 1.96 ? '*' : ' ';
    console.log(`  beta=${(c.beta >= 0 ? '+' : '') + c.beta.toFixed(3)}  t=${c.t.toFixed(2).padStart(6)} ${sig}  ${c.l}`);
  }

  // 3) Multiple regression, Overall excluded entirely
  const Xwithout = rows.map((_, i) => [1, ...jsKeys.map(k => ratingZ[k][i])]);
  const mWithout = ols(Xwithout, metricArr);
  const labelsWithout = jsKeys;
  const coefsWithout = labelsWithout.map((l, i) => ({ l, beta: mWithout.beta[i + 1], t: mWithout.t[i + 1] }));
  coefsWithout.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  console.log(`\nMultiple regression, Overall EXCLUDED (R^2=${mWithout.r2.toFixed(3)}):`);
  for (const c of coefsWithout) {
    const sig = Math.abs(c.t) > 1.96 ? '*' : ' ';
    console.log(`  beta=${(c.beta >= 0 ? '+' : '') + c.beta.toFixed(3)}  t=${c.t.toFixed(2).padStart(6)} ${sig}  ${c.l}`);
  }

  survivors[metricName] = coefsWith.filter(c => Math.abs(c.t) > 1.96).map(c => c.l);
}

// --- Interaction stress test: Speed x Elusiveness (classic "breakaway back" archetype) ---
// on the metric where both show up as significant solo/competing predictors (Avg and 10+R
// are the natural candidates since they're about explosive-play tendency, not raw volume).
console.log(`\n${'='.repeat(78)}\nINTERACTION STRESS TEST: Speed x Elusiveness\n${'='.repeat(78)}`);
for (const [metricName, metricArr] of metrics) {
  const sp = ratingZ.Speed, el = ratingZ.Elusiveness;
  const OA2 = OA.map(v => v * v);
  const spOA = sp.map((v, i) => v * OA[i]);
  const elOA = el.map((v, i) => v * OA[i]);
  const spEl = sp.map((v, i) => v * el[i]);

  const Xbase = rows.map((_, i) => [1, OA[i], OA2[i], sp[i], el[i], spOA[i], elOA[i]]);
  const mBase = ols(Xbase, metricArr);
  const Xfull = rows.map((_, i) => [1, OA[i], OA2[i], sp[i], el[i], spOA[i], elOA[i], spEl[i]]);
  const mFull = ols(Xfull, metricArr);
  const dR2 = mFull.r2 - mBase.r2;
  const interactionT = mFull.t[7];
  console.log(`\n${metricName}`);
  console.log(`  Base (Overall, Overall^2, Speed, Elusiveness, Speed*Overall, Elusiveness*Overall): R^2=${mBase.r2.toFixed(4)}`);
  console.log(`  + Speed*Elusiveness term: R^2=${mFull.r2.toFixed(4)}  (deltaR2=${dR2.toFixed(4)}, t=${interactionT.toFixed(2)}${Math.abs(interactionT) > 1.96 ? ' *' : ' (not significant)'})`);
}

// ============================================================================
// PART B — combine measurables vs career production, current roster (player_record)
// ============================================================================
console.log(`\n${'='.repeat(78)}\nPART B: RB COMBINE MEASURABLES vs CAREER PRODUCTION  (current roster only)\n${'='.repeat(78)}`);

const MIN_CAREER_RUSHES = 100;
const combineRows = db.prepare(`
  SELECT pr.Player_ID,
         pr."40-Yard_Dash" AS Dash, pr.Bench_Press AS Bench, pr.Agility_Drill AS Agility,
         pr.Broad_Jump AS Broad, pr.Position_Drill AS PosDrill, pr.Solecismic_Test AS Solecismic,
         (SELECT SUM(Rushing_Yards) FROM player_year_summary WHERE Player_ID = pr.Player_ID AND Position = 'RB') AS CareerYards,
         (SELECT SUM(Rushes) FROM player_year_summary WHERE Player_ID = pr.Player_ID AND Position = 'RB') AS CareerRushes,
         (SELECT SUM("10-Yard_Runs") FROM player_year_summary WHERE Player_ID = pr.Player_ID AND Position = 'RB') AS Career10PlusR,
         (SELECT SUM(Games_Played) FROM player_year_summary WHERE Player_ID = pr.Player_ID AND Position = 'RB') AS CareerGames
  FROM player_record pr
  WHERE pr.Position = 'RB' AND pr."40-Yard_Dash" > 0
`).all().filter(r => r.CareerRushes >= MIN_CAREER_RUSHES);

console.log(`n=${combineRows.length} RBs with a worked-out 40 time and >=${MIN_CAREER_RUSHES} career rushes\n`);

const combineMetrics = [
  ['Career Yards / Game', combineRows.map(r => r.CareerYards / r.CareerGames)],
  ['Career Avg (Yards / Rush)', combineRows.map(r => r.CareerYards / r.CareerRushes)],
  ['Career 10+R rate (10-Yard_Runs / Rush)', combineRows.map(r => r.Career10PlusR / r.CareerRushes)],
];
const combineCandidates = ['Dash', 'Bench', 'Agility', 'Broad', 'PosDrill', 'Solecismic'];
// Negate Dash so higher = better/faster, for readable regression signs alongside the others
const combineZ = {};
for (const k of combineCandidates) {
  const raw = combineRows.map(r => r[k]);
  combineZ[k] = k === 'Dash' ? zscore(raw.map(v => -v)) : zscore(raw);
}

console.log('Collinearity among combine measurables (pairwise r, |r|>=0.5 flagged):');
for (let i = 0; i < combineCandidates.length; i++) {
  for (let j = i + 1; j < combineCandidates.length; j++) {
    const r = pearson(combineZ[combineCandidates[i]], combineZ[combineCandidates[j]]);
    if (Math.abs(r) >= 0.5) console.log(`  ${r >= 0 ? '+' : ''}${r.toFixed(3)}  ${combineCandidates[i]} <-> ${combineCandidates[j]} (Dash negated: + means faster)`);
  }
}

for (const [metricName, metricArr] of combineMetrics) {
  console.log(`\n${'-'.repeat(78)}\n${metricName}\n${'-'.repeat(78)}`);
  const solo = combineCandidates.map(k => ({ k, r: pearson(combineZ[k], metricArr) }));
  solo.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  console.log('Solo correlation (Dash negated so + = faster):');
  for (const s of solo) console.log(`  ${s.r >= 0 ? '+' : ''}${s.r.toFixed(3)}  ${s.k}`);

  const X = combineRows.map((_, i) => [1, ...combineCandidates.map(k => combineZ[k][i])]);
  const m = ols(X, metricArr);
  const coefs = combineCandidates.map((l, i) => ({ l, beta: m.beta[i + 1], t: m.t[i + 1] }));
  coefs.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  console.log(`\nMultiple regression, all combine measurables competing (R^2=${m.r2.toFixed(3)}):`);
  for (const c of coefs) {
    const sig = Math.abs(c.t) > 1.96 ? '*' : ' ';
    console.log(`  beta=${(c.beta >= 0 ? '+' : '') + c.beta.toFixed(3)}  t=${c.t.toFixed(2).padStart(6)} ${sig}  ${c.l}`);
  }
}

db.close();
