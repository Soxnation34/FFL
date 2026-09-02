// Which ratings actually drive sacks/hurries for edge rushers (DE) vs interior linemen (DT/NT)?
// For each position group: (1) partial correlation of each candidate rating with the metric,
// controlling for Current_Overall, and (2) a multiple regression with all candidate ratings
// entered together (so correlated ratings compete for credit instead of double-counting).
// Usage: node scripts/dl_pass_rush_drivers.js
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'ffl.db'));

// Only ratings confirmed non-zero (i.e. actually used by the engine) for DL positions.
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

function analyzeGroup(label, positions) {
  const ph = positions.map(() => '?').join(',');
  const cols = ['Games_Played', '"Sacks_(x10)" AS Sacks10', 'Hurries', 'Quarterback_Knockdowns', 'Current_Overall AS OA']
    .concat(CANDIDATES.map(c => `"${c}" AS ${c.replace(/[^A-Za-z0-9]/g, '_')}`));
  const jsKeys = CANDIDATES.map(c => c.replace(/[^A-Za-z0-9]/g, '_'));
  const sql = `SELECT ${cols.join(', ')} FROM player_year_summary
               WHERE Position IN (${ph}) AND Current_Overall IS NOT NULL AND Games_Played >= 8`;
  const rows = db.prepare(sql).all(...positions);

  console.log(`\n${'='.repeat(74)}\n${label}  (n=${rows.length})\n${'='.repeat(74)}`);

  const OA = zscore(rows.map(r => r.OA));
  const ratingZ = {};
  for (const k of jsKeys) ratingZ[k] = zscore(rows.map(r => r[k]));

  for (const [metricName, metricArr] of [
    ['Sacks / Game', rows.map(r => r.Sacks10 * 0.1 / r.Games_Played)],
    ['Hurries / Game', rows.map(r => r.Hurries / r.Games_Played)],
  ]) {
    console.log(`\n  --- ${metricName} ---`);

    // 1) partial correlation of each rating alone, controlling only for Overall
    const partials = jsKeys.map(k => {
      const r = pearson(ratingZ[k], metricArr);
      const rxz = pearson(ratingZ[k], OA);
      const ryz = pearson(metricArr, OA);
      return { k, partial: partialCorr(r, rxz, ryz) };
    });
    partials.sort((a, b) => Math.abs(b.partial) - Math.abs(a.partial));
    console.log('  Solo partial r (controlling only for Overall):');
    for (const p of partials) console.log(`    ${p.partial >= 0 ? '+' : ''}${p.partial.toFixed(3)}  ${p.k}`);

    // 2) multiple regression with ALL candidate ratings + Overall entered together
    const X = rows.map((_, i) => [1, OA[i], ...jsKeys.map(k => ratingZ[k][i])]);
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
}

analyzeGroup('EDGE (LDE/RDE)', ['LDE', 'RDE']);
analyzeGroup('INTERIOR (LDT/RDT/NT)', ['LDT', 'RDT', 'NT']);

db.close();
