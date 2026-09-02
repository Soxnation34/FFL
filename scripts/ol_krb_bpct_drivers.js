// Which ratings and combine measurables drive Offensive Line run-blocking production?
// KRB = Key_Run_Blocks (rate: per game). BPct = "blocking percentage" = Key_Run_Blocks /
// Block_Opportunities * 100, the success rate on run-blocking opportunities.
// Positions: LT, LG, C, RG, RT.
//
// Methodology per cfl_ratings_stats_analysis_methodology: partial correlation controlling for
// Current_Overall, collinearity check among candidates, multiple regression with all ratings
// competing, Overall-excluded view, for the ratings half; then combine measurables vs career
// production on current-roster OL for the second half (mirrors the RB/edge-rusher pipelines).
// Usage: node scripts/ol_krb_bpct_drivers.js
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'ffl.db'));

// OL-applicable skill ratings only (Run_Blocking/Pass_Blocking/Blocking_Strength are ~99%
// nonzero for OL; everything else — Speed, Power_Inside, etc. — is 0% and not applicable).
const CANDIDATES = ['Run_Blocking', 'Pass_Blocking', 'Blocking_Strength'];
const jsKeys = CANDIDATES;
const OL_POSITIONS = ['LT', 'LG', 'C', 'RG', 'RT'];

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
// PART A — ratings drivers, season-level OL (Current_Overall > 0, i.e. Year>=2039)
// ============================================================================
const MIN_OPPS = 20;
const ph = OL_POSITIONS.map(() => '?').join(',');
const sql = `SELECT Player_ID, Year, Position, Games_Played, Key_Run_Blocks, Block_Opportunities, Current_Overall AS OA,
                    Run_Blocking, Pass_Blocking, Blocking_Strength
             FROM player_year_summary
             WHERE Position IN (${ph}) AND Current_Overall > 0 AND Games_Played >= 4 AND Block_Opportunities >= ${MIN_OPPS}`;
const rows = db.prepare(sql).all(...OL_POSITIONS);

console.log('='.repeat(78));
console.log(`PART A: OL RATINGS DRIVERS (season-level, n=${rows.length})`);
console.log('='.repeat(78));

console.log('\nCollinearity among the 3 OL ratings (pairwise r):');
for (let i = 0; i < jsKeys.length; i++) {
  for (let j = i + 1; j < jsKeys.length; j++) {
    const r = pearson(rows.map(x => x[jsKeys[i]]), rows.map(x => x[jsKeys[j]]));
    console.log(`  ${r >= 0 ? '+' : ''}${r.toFixed(3)}  ${jsKeys[i]} <-> ${jsKeys[j]}`);
  }
}

const OA = zscore(rows.map(r => r.OA));
const ratingZ = {}; for (const k of jsKeys) ratingZ[k] = zscore(rows.map(r => r[k]));

const metrics = [
  ['KRB / Game (Key_Run_Blocks / Games_Played)', rows.map(r => r.Key_Run_Blocks / r.Games_Played)],
  ['BPct (Key_Run_Blocks / Block_Opportunities * 100)', rows.map(r => 100 * r.Key_Run_Blocks / r.Block_Opportunities)],
];

for (const [metricName, metricArr] of metrics) {
  console.log(`\n${'-'.repeat(78)}\n${metricName}\n${'-'.repeat(78)}`);

  const partials = jsKeys.map(k => {
    const r = pearson(ratingZ[k], metricArr);
    const rxz = pearson(ratingZ[k], OA);
    const ryz = pearson(metricArr, OA);
    return { k, partial: partialCorr(r, rxz, ryz) };
  });
  partials.sort((a, b) => Math.abs(b.partial) - Math.abs(a.partial));
  console.log('Solo partial r (controlling only for Current_Overall):');
  for (const p of partials) console.log(`  ${p.partial >= 0 ? '+' : ''}${p.partial.toFixed(3)}  ${p.k}`);

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

  const Xwithout = rows.map((_, i) => [1, ...jsKeys.map(k => ratingZ[k][i])]);
  const mWithout = ols(Xwithout, metricArr);
  const coefsWithout = jsKeys.map((l, i) => ({ l, beta: mWithout.beta[i + 1], t: mWithout.t[i + 1] }));
  coefsWithout.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  console.log(`\nMultiple regression, Overall EXCLUDED (R^2=${mWithout.r2.toFixed(3)}):`);
  for (const c of coefsWithout) {
    const sig = Math.abs(c.t) > 1.96 ? '*' : ' ';
    console.log(`  beta=${(c.beta >= 0 ? '+' : '') + c.beta.toFixed(3)}  t=${c.t.toFixed(2).padStart(6)} ${sig}  ${c.l}`);
  }
}

// ============================================================================
// PART B — combine measurables vs career production, current roster OL
// ============================================================================
console.log(`\n${'='.repeat(78)}\nPART B: OL COMBINE MEASURABLES vs CAREER PRODUCTION (current roster only)\n${'='.repeat(78)}`);

const MIN_CAREER_OPPS = 100;
const combineRows = db.prepare(`
  SELECT pr.Player_ID, pr.Position,
         pr."40-Yard_Dash" AS Dash, pr.Bench_Press AS Bench, pr.Agility_Drill AS Agility,
         pr.Broad_Jump AS Broad, pr.Position_Drill AS PosDrill, pr.Solecismic_Test AS Solecismic,
         (SELECT SUM(Key_Run_Blocks) FROM player_year_summary WHERE Player_ID = pr.Player_ID AND Position = pr.Position) AS CareerKRB,
         (SELECT SUM(Block_Opportunities) FROM player_year_summary WHERE Player_ID = pr.Player_ID AND Position = pr.Position) AS CareerOpps,
         (SELECT SUM(Games_Played) FROM player_year_summary WHERE Player_ID = pr.Player_ID AND Position = pr.Position) AS CareerGames
  FROM player_record pr
  WHERE pr.Position IN ('LT','LG','C','RG','RT') AND pr."40-Yard_Dash" > 0
`).all().filter(r => r.CareerOpps >= MIN_CAREER_OPPS);

console.log(`n=${combineRows.length} current-roster OL with a worked-out 40 time and >=${MIN_CAREER_OPPS} career block opportunities\n`);

const combineMetrics = [
  ['Career KRB / Game', combineRows.map(r => r.CareerKRB / r.CareerGames)],
  ['Career BPct (KRB / Block Opportunities * 100)', combineRows.map(r => 100 * r.CareerKRB / r.CareerOpps)],
];
// Position_Drill is not administered to OL (always 0 in player_record for LT/LG/C/RG/RT) —
// excluded here, unlike the RB/edge-rusher pipelines where it's a real measurable.
const combineCandidates = ['Dash', 'Bench', 'Agility', 'Broad', 'Solecismic'];
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
