// Which ratings drive Passes_Defensed/Game (Defn), Caught_Against/Game (Caugh), and
// PDPct (Passes_Defensed / Targets) for cornerbacks (LCB/RCB)?
// Same methodology as dl_pass_rush_drivers.js / dt_tackle_drivers.js: (1) solo partial
// correlation controlling for Current_Overall, (2) a multiple regression with Overall
// INCLUDED (all ratings compete, but Overall can suppress/absorb them via collinearity),
// and (3) — per explicit request — a multiple regression with Overall EXCLUDED entirely,
// which lets ratings that are otherwise suppressed by collinearity with Overall show their
// raw predictive value (step 4 of cfl_ratings_stats_analysis_methodology memory).
//
// Candidate ratings restricted to those actually nonzero for CB in this export (verified via
// nonzero% check): Man-to-Man_Defense, Zone_Defense, Bump-and-Run_Defense, Intercepting,
// Play_Diagnosis, Punishing_Hitter, Endurance, Special_Teams, Run_Defense. (Speed, Speed_Outside,
// Courage, Read_Defense, Sense_Rush, Pass_Rush_Technique/Strength are all 0% for CB — excluded.)
// Usage: node scripts/cb_pass_defense_drivers.js
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'ffl.db'));

const CANDIDATES = [
  'Man-to-Man_Defense', 'Zone_Defense', 'Bump-and-Run_Defense', 'Intercepting',
  'Play_Diagnosis', 'Punishing_Hitter', 'Endurance', 'Special_Teams', 'Run_Defense',
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
    for (let r = 0; r < n; r++) { if (r === col) continue; const f = A[r][col]; for (let c = 0; c < 2 * n; c++) A[r][c] -= f * A[col][c]; }
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

// NOTE: this export's "Targets" column is only ever populated for the receiver's own stat
// line (0 for every CB row) — there is no explicit targets-against field for defenders.
// PDPct is therefore defined as Passes_Defensed / (Passes_Defensed + Caught_Against), the
// standard proxy for "rate of contested/catchable targets broken up" when a true
// targets-against count isn't tracked.
const jsKeys = CANDIDATES.map(c => c.replace(/[^A-Za-z0-9]/g, '_'));
const cols = ['Games_Played', 'Passes_Defensed', 'Caught_Against', 'Current_Overall AS OA']
  .concat(CANDIDATES.map(c => `"${c}" AS ${c.replace(/[^A-Za-z0-9]/g, '_')}`));
const rows = db.prepare(`
  SELECT ${cols.join(', ')} FROM player_year_summary
  WHERE Position IN ('LCB','RCB') AND Current_Overall > 0 AND Games_Played >= 8 AND (Passes_Defensed + Caught_Against) > 0
`).all();

console.log(`${'='.repeat(80)}\nCORNERBACK (LCB/RCB) — Defn, Caugh, PDPct driver analysis (n=${rows.length})\n${'='.repeat(80)}`);

const OA = zscore(rows.map(r => r.OA));
const ratingZ = {};
for (const k of jsKeys) ratingZ[k] = zscore(rows.map(r => r[k]));

const metrics = [
  ['Defn (Passes_Defensed / Game)', rows.map(r => r.Passes_Defensed / r.Games_Played)],
  ['Caugh (Caught_Against / Game)', rows.map(r => r.Caught_Against / r.Games_Played)],
  ['PDPct (Passes_Defensed / (Passes_Defensed + Caught_Against))', rows.map(r => 100 * r.Passes_Defensed / (r.Passes_Defensed + r.Caught_Against))],
];

for (const [metricName, metricArr] of metrics) {
  console.log(`\n${'-'.repeat(80)}\n${metricName}\n${'-'.repeat(80)}`);

  const partials = jsKeys.map(k => {
    const r = pearson(ratingZ[k], metricArr);
    const rxz = pearson(ratingZ[k], OA);
    const ryz = pearson(metricArr, OA);
    return { k, raw: r, partial: partialCorr(r, rxz, ryz) };
  });
  const byPartial = [...partials].sort((a, b) => Math.abs(b.partial) - Math.abs(a.partial));
  console.log('  Raw r  |  Solo partial r (controlling for Overall):');
  for (const p of byPartial) console.log(`    raw=${(p.raw >= 0 ? '+' : '') + p.raw.toFixed(3)}  partial=${(p.partial >= 0 ? '+' : '') + p.partial.toFixed(3)}  ${p.k}`);

  // Multiple regression WITH Overall
  const Xwith = rows.map((_, i) => [1, OA[i], ...jsKeys.map(k => ratingZ[k][i])]);
  const mWith = ols(Xwith, metricArr);
  const labelsWith = ['intercept', 'Current_Overall', ...jsKeys];
  const coefsWith = labelsWith.map((l, i) => ({ l, beta: mWith.beta[i], t: mWith.t[i] })).slice(1);
  coefsWith.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  console.log(`\n  Multiple regression WITH Overall (R^2=${mWith.r2.toFixed(3)}):`);
  for (const c of coefsWith) {
    const sig = Math.abs(c.t) > 1.96 ? '*' : ' ';
    console.log(`    beta=${(c.beta >= 0 ? '+' : '') + c.beta.toFixed(3)}  t=${c.t.toFixed(2).padStart(6)} ${sig}  ${c.l}`);
  }

  // Multiple regression WITHOUT Overall (raw predictive value, per explicit request)
  const Xwithout = rows.map((_, i) => [1, ...jsKeys.map(k => ratingZ[k][i])]);
  const mWithout = ols(Xwithout, metricArr);
  const labelsWithout = ['intercept', ...jsKeys];
  const coefsWithout = labelsWithout.map((l, i) => ({ l, beta: mWithout.beta[i], t: mWithout.t[i] })).slice(1);
  coefsWithout.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  console.log(`\n  Multiple regression WITHOUT Overall (R^2=${mWithout.r2.toFixed(3)}):`);
  for (const c of coefsWithout) {
    const sig = Math.abs(c.t) > 1.96 ? '*' : ' ';
    console.log(`    beta=${(c.beta >= 0 ? '+' : '') + c.beta.toFixed(3)}  t=${c.t.toFixed(2).padStart(6)} ${sig}  ${c.l}`);
  }
}

db.close();
