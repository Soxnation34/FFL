// Which ratings drive Tackles/Game and Tackle% (Tackles/Run_Plays) for interior DL (LDT/RDT/NT)?
// Same methodology as dl_pass_rush_drivers.js: partial correlation controlling for Current_Overall,
// then a multiple regression with all candidate ratings entered together so correlated ratings
// compete for credit instead of double-counting (per cfl_ratings_stats_analysis_methodology memory).
//
// Then fits a veteran-ceiling projection (Experience>=5, per cfl_position_aging_curves memory —
// DT Overall/Run_Defense peak at Experience 5) of Tackles/Game and TkPct from Run_Defense +
// Play_Diagnosis, and applies it to a given prospect's scout Low/High range.
//
// Usage: node scripts/dt_tackle_drivers.js [Player_ID]
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'ffl.db'));
const targetPid = process.argv[2] ? Number(process.argv[2]) : 63885; // Darius Grabowski default

const CANDIDATES = [
  'Run_Defense', 'Pass_Rush_Technique', 'Pass_Rush_Strength', 'Play_Diagnosis',
  'Man-to-Man_Defense', 'Zone_Defense', 'Bump-and-Run_Defense', 'Punishing_Hitter',
  'Endurance', 'Special_Teams',
];

function zscore(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
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

const POSITIONS = ['LDT', 'RDT', 'NT'];

// --- Step 1: driver discovery on the full historical panel (Games_Played>=8, Current_Overall>0) ---
const ph = POSITIONS.map(() => '?').join(',');
const jsKeys = CANDIDATES.map(c => c.replace(/[^A-Za-z0-9]/g, '_'));
const driverCols = ['Games_Played', 'Tackles', 'Assists', 'Run_Plays', 'Current_Overall AS OA']
  .concat(CANDIDATES.map(c => `"${c}" AS ${c.replace(/[^A-Za-z0-9]/g, '_')}`));
const driverRows = db.prepare(`
  SELECT ${driverCols.join(', ')} FROM player_year_summary
  WHERE Position IN (${ph}) AND Current_Overall > 0 AND Games_Played >= 8 AND Run_Plays > 0
`).all(...POSITIONS);

console.log(`${'='.repeat(78)}\nINTERIOR DL (LDT/RDT/NT) — Tackles/Game and TkPct driver analysis (n=${driverRows.length})\n${'='.repeat(78)}`);

const OA = zscore(driverRows.map(r => r.OA));
const ratingZ = {};
for (const k of jsKeys) ratingZ[k] = zscore(driverRows.map(r => r[k]));

// candidate rating intercorrelation check (per methodology: check before trusting multi-regression coefs)
const rdZ = ratingZ['Run_Defense'], pdZ = ratingZ['Play_Diagnosis'];
console.log(`\nRun_Defense vs Play_Diagnosis raw r = ${pearson(rdZ, pdZ).toFixed(3)} (candidate-rating intercorrelation check)`);

for (const [metricName, metricArr] of [
  ['Tackles / Game', driverRows.map(r => r.Tackles / r.Games_Played)],
  ['TkPct (Tackles / Run_Plays)', driverRows.map(r => 100 * r.Tackles / r.Run_Plays)],
]) {
  console.log(`\n  --- ${metricName} ---`);

  const partials = jsKeys.map(k => {
    const r = pearson(ratingZ[k], metricArr);
    const rxz = pearson(ratingZ[k], OA);
    const ryz = pearson(metricArr, OA);
    return { k, raw: r, partial: partialCorr(r, rxz, ryz) };
  });
  partials.sort((a, b) => Math.abs(b.partial) - Math.abs(a.partial));
  console.log('  Raw r  |  Solo partial r (controlling for Overall):');
  for (const p of partials) console.log(`    raw=${(p.raw >= 0 ? '+' : '') + p.raw.toFixed(3)}  partial=${(p.partial >= 0 ? '+' : '') + p.partial.toFixed(3)}  ${p.k}`);

  const X = driverRows.map((_, i) => [1, OA[i], ...jsKeys.map(k => ratingZ[k][i])]);
  const m = ols(X, metricArr);
  const labels = ['intercept', 'Current_Overall', ...jsKeys];
  const coefs = labels.map((l, i) => ({ l, beta: m.beta[i], t: m.t[i] })).slice(1);
  coefs.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  console.log(`  Multiple regression (all ratings competing together, R^2=${m.r2.toFixed(3)}):`);
  for (const c of coefs) {
    const sig = Math.abs(c.t) > 1.96 ? '*' : ' ';
    console.log(`    beta=${(c.beta >= 0 ? '+' : '') + c.beta.toFixed(3)}  t=${c.t.toFixed(2).padStart(6)} ${sig}  ${c.l}`);
  }
}

// --- Step 2: veteran-ceiling projection, Run_Defense + Play_Diagnosis -> Tackles/Game, TkPct ---
// Experience>=5 per cfl_position_aging_curves memory (DT Overall/Run_Defense peak Exp5).
const projRows = db.prepare(`
  SELECT pys.Games_Played, pys.Tackles, pys.Run_Plays, pys.Run_Defense AS RD, pys.Play_Diagnosis AS PD
  FROM player_year_summary pys JOIN player_information pi ON pi.Player_ID = pys.Player_ID
  WHERE pys.Position IN (${ph}) AND pys.Current_Overall > 0 AND pys.Games_Played >= 4 AND pys.Run_Plays > 0
    AND pi.Draft_Year > 0 AND (pys.Year - pi.Draft_Year) >= 5
`).all(...POSITIONS);

const tklGameArr = projRows.map(r => r.Tackles / r.Games_Played);
const tkPctArr = projRows.map(r => 100 * r.Tackles / r.Run_Plays);
const Xproj = projRows.map(r => [1, r.RD, r.PD]);
const mTkl = ols(Xproj, tklGameArr);
const mPct = ols(Xproj, tkPctArr);

console.log(`\n${'='.repeat(78)}\nVETERAN-CEILING PROJECTION, Experience>=5 (n=${projRows.length})\n${'='.repeat(78)}`);
console.log(`  Tackles/Game = ${mTkl.beta[0].toFixed(4)} + ${mTkl.beta[1].toFixed(5)}*Run_Defense + ${mTkl.beta[2].toFixed(5)}*Play_Diagnosis  (R^2=${mTkl.r2.toFixed(3)})`);
console.log(`  TkPct        = ${mPct.beta[0].toFixed(4)} + ${mPct.beta[1].toFixed(5)}*Run_Defense + ${mPct.beta[2].toFixed(5)}*Play_Diagnosis  (R^2=${mPct.r2.toFixed(3)})`);

function predictTkl(rd, pd) { return mTkl.beta[0] + mTkl.beta[1] * rd + mTkl.beta[2] * pd; }
function predictPct(rd, pd) { return mPct.beta[0] + mPct.beta[1] * rd + mPct.beta[2] * pd; }

// --- Step 3: apply to target prospect using scout Low/High range midpoints ---
// rookies/draft_personal only exist in a draft-window export; skip this step when they're absent.
const draftTables = db.prepare(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('rookies', 'draft_personal')`
).all();
const prospect = draftTables.length < 2 ? undefined : db.prepare(`
  SELECT r.Player_ID, r.Last_Name, r.First_Name, r.Weight, r.Grade,
         dp."Low_Run_Defense" AS rd_lo, dp."High_Run_Defense" AS rd_hi,
         dp."Low_Play_Diagnosis" AS pd_lo, dp."High_Play_Diagnosis" AS pd_hi
  FROM rookies r JOIN draft_personal dp ON dp.Player_ID = r.Player_ID
  WHERE r.Player_ID = ?
`).get(targetPid);

if (prospect) {
  const rdMid = (prospect.rd_lo + prospect.rd_hi) / 2;
  const pdMid = (prospect.pd_lo + prospect.pd_hi) / 2;
  console.log(`\n${'='.repeat(78)}\n${prospect.First_Name} ${prospect.Last_Name} (Wt ${prospect.Weight}, Grade ${prospect.Grade})\n${'='.repeat(78)}`);
  console.log(`  Run_Defense range ${prospect.rd_lo}-${prospect.rd_hi} (mid ${rdMid})`);
  console.log(`  Play_Diagnosis range ${prospect.pd_lo}-${prospect.pd_hi} (mid ${pdMid})`);
  console.log(`  Projected Tackles/Game = ${predictTkl(rdMid, pdMid).toFixed(3)}`);
  console.log(`  Projected TkPct        = ${predictPct(rdMid, pdMid).toFixed(2)}%`);
} else if (draftTables.length < 2) {
  console.log(`\nSkipping prospect projection: rookies/draft_personal tables not in ffl.db (re-export during the draft window).`);
} else {
  console.log(`\nPlayer_ID ${targetPid} not found in rookies/draft_personal.`);
}

db.close();
