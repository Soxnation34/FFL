// Tests whether Pass_Rush_Technique and Play_Diagnosis have a synergistic (interaction)
// effect on DE sack/hurry/pressure production, beyond their individual (additive) effects,
// controlling for Current_Overall.
// Usage: node scripts/de_pass_rush_synergy.js
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'ffl.db'));

const rows = db.prepare(`
  SELECT Games_Played, "Sacks_(x10)" AS Sacks10, Hurries, Quarterback_Knockdowns,
         "Pass_Rush_Technique" AS PRT, "Play_Diagnosis" AS PD, Current_Overall AS OA
  FROM player_year_summary
  WHERE Position IN ('LDE','RDE') AND Current_Overall IS NOT NULL AND Games_Played >= 8
`).all();

console.log(`DE player-seasons (Games_Played>=8): ${rows.length}`);

// Raw correlation between the two ratings themselves (multicollinearity check)
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
const prtRaw = rows.map(r => r.PRT);
const pdRaw = rows.map(r => r.PD);
console.log(`Pass_Rush_Technique <-> Play_Diagnosis raw correlation: r=${pearson(prtRaw, pdRaw).toFixed(3)}\n`);

function zscore(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return arr.map(v => (v - mean) / sd);
}

// ---- tiny OLS engine (normal equations + Gauss-Jordan inverse) ----
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
  // X'X
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
  // residuals / SSR / SE
  let ssr = 0, sst = 0;
  const ymean = y.reduce((a, b) => a + b, 0) / n;
  const fitted = X.map(row => row.reduce((s, v, k) => s + v * beta[k], 0));
  for (let i = 0; i < n; i++) {
    ssr += (y[i] - fitted[i]) ** 2;
    sst += (y[i] - ymean) ** 2;
  }
  const sigma2 = ssr / (n - p);
  const se = inv.map((row, i) => Math.sqrt(sigma2 * row[i]));
  const t = beta.map((b, i) => b / se[i]);
  const r2 = 1 - ssr / sst;
  return { beta, se, t, r2, ssr, n, p };
}

function runMetric(name, yRaw, scale) {
  const y = yRaw.map(v => v * (scale || 1));
  const PRT = zscore(rows.map(r => r.PRT));
  const PD = zscore(rows.map(r => r.PD));
  const OA = zscore(rows.map(r => r.OA));
  const inter = PRT.map((v, i) => v * PD[i]);

  const Xnoint = rows.map((_, i) => [1, PRT[i], PD[i], OA[i]]);
  const Xint = rows.map((_, i) => [1, PRT[i], PD[i], OA[i], inter[i]]);

  const m0 = ols(Xnoint, y);
  const m1 = ols(Xint, y);

  console.log(`--- ${name} ---`);
  console.log(`  Model WITHOUT interaction: R^2=${m0.r2.toFixed(4)}`);
  console.log(`    Pass_Rush_Technique  beta=${m0.beta[1].toFixed(4)}  t=${m0.t[1].toFixed(2)}`);
  console.log(`    Play_Diagnosis       beta=${m0.beta[2].toFixed(4)}  t=${m0.t[2].toFixed(2)}`);
  console.log(`    Current_Overall      beta=${m0.beta[3].toFixed(4)}  t=${m0.t[3].toFixed(2)}`);
  console.log(`  Model WITH interaction:    R^2=${m1.r2.toFixed(4)}  (delta R^2 = ${(m1.r2 - m0.r2).toFixed(4)})`);
  console.log(`    Pass_Rush_Technique  beta=${m1.beta[1].toFixed(4)}  t=${m1.t[1].toFixed(2)}`);
  console.log(`    Play_Diagnosis       beta=${m1.beta[2].toFixed(4)}  t=${m1.t[2].toFixed(2)}`);
  console.log(`    Current_Overall      beta=${m1.beta[3].toFixed(4)}  t=${m1.t[3].toFixed(2)}`);
  console.log(`    PRT x PD interaction beta=${m1.beta[4].toFixed(4)}  t=${m1.t[4].toFixed(2)}  ${Math.abs(m1.t[4]) > 1.96 ? '(significant at p<.05)' : '(not significant)'}`);
  console.log();
  return { m0, m1 };
}

runMetric('Sacks / Game', rows.map(r => r.Sacks10 / r.Games_Played), 0.1);
runMetric('Hurries / Game', rows.map(r => r.Hurries / r.Games_Played));
runMetric('QB Knockdowns / Game', rows.map(r => r.Quarterback_Knockdowns / r.Games_Played));
runMetric('Pressure (Sacks*10 + Hurries + Knockdowns) / Game',
  rows.map(r => (r.Sacks10 + r.Hurries + r.Quarterback_Knockdowns) / r.Games_Played));

// ---- Stress test: is PRT x PD just proxying generic "Overall is nonlinear"? ----
// Compare against a model that also gets Overall^2, Overall*PRT, and Overall*PD to compete for
// the same variance. If PRT x PD still adds meaningfully, it's a specific, not generic, effect.
function stressTest(name, yRaw, scale) {
  const y = yRaw.map(v => v * (scale || 1));
  const PRT = zscore(rows.map(r => r.PRT));
  const PD = zscore(rows.map(r => r.PD));
  const OA = zscore(rows.map(r => r.OA));
  const prtPd = PRT.map((v, i) => v * PD[i]);
  const oa2 = OA.map(v => v * v);
  const oaPrt = OA.map((v, i) => v * PRT[i]);
  const oaPd = OA.map((v, i) => v * PD[i]);

  const Xfull = rows.map((_, i) => [1, PRT[i], PD[i], OA[i], oa2[i], oaPrt[i], oaPd[i], prtPd[i]]);
  const Xwithout = rows.map((_, i) => [1, PRT[i], PD[i], OA[i], oa2[i], oaPrt[i], oaPd[i]]);

  const full = ols(Xfull, y);
  const without = ols(Xwithout, y);
  console.log(`--- ${name}: PRT x PD vs. Overall-nonlinearity controls ---`);
  console.log(`  R^2 with [Overall^2, Overall*PRT, Overall*PD] only: ${without.r2.toFixed(4)}`);
  console.log(`  R^2 adding PRT x PD on top:                          ${full.r2.toFixed(4)}  (delta=${(full.r2 - without.r2).toFixed(4)})`);
  console.log(`  PRT x PD beta=${full.beta[7].toFixed(4)}  t=${full.t[7].toFixed(2)}  ${Math.abs(full.t[7]) > 1.96 ? '(still significant)' : '(not significant once controlled)'}\n`);
}
stressTest('Sacks / Game', rows.map(r => r.Sacks10 / r.Games_Played), 0.1);
stressTest('Hurries / Game', rows.map(r => r.Hurries / r.Games_Played));
stressTest('QB Knockdowns / Game', rows.map(r => r.Quarterback_Knockdowns / r.Games_Played));

// ---- Quadrant view (rank-based split, robust to PD's heavy clustering at 0) ----
function rankHalf(arr) {
  // returns a boolean array: true = upper half by rank (ties broken by original order)
  const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b] || a - b);
  const isHigh = Array(arr.length).fill(false);
  for (let k = Math.floor(arr.length / 2); k < arr.length; k++) isHigh[idx[k]] = true;
  return isHigh;
}
function quadrantTable(name, yRaw, scale) {
  const y = yRaw.map(v => v * (scale || 1));
  const prtHigh = rankHalf(rows.map(r => r.PRT));
  const pdHigh = rankHalf(rows.map(r => r.PD));
  const cells = { LL: [], LH: [], HL: [], HH: [] };
  rows.forEach((r, i) => {
    const key = (prtHigh[i] ? 'H' : 'L') + (pdHigh[i] ? 'H' : 'L');
    cells[key].push(y[i]);
  });
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const LL = avg(cells.LL), LH = avg(cells.LH), HL = avg(cells.HL), HH = avg(cells.HH);
  const expectedHH = LL + (HL - LL) + (LH - LL);
  console.log(`--- ${name}: rank-based half-split quadrants (top half vs bottom half of each rating) ---`);
  console.log(`  Low PRT / Low PD  : ${LL.toFixed(3)}  (n=${cells.LL.length})`);
  console.log(`  High PRT / Low PD : ${HL.toFixed(3)}  (n=${cells.HL.length})`);
  console.log(`  Low PRT / High PD : ${LH.toFixed(3)}  (n=${cells.LH.length})`);
  console.log(`  High PRT / High PD: ${HH.toFixed(3)}  (n=${cells.HH.length})  <- actual`);
  console.log(`  Expected if purely additive: ${expectedHH.toFixed(3)}`);
  console.log(`  Synergy (actual - expected): ${(HH - expectedHH).toFixed(3)}\n`);
}

quadrantTable('Sacks / Game', rows.map(r => r.Sacks10 / r.Games_Played), 0.1);
quadrantTable('Hurries / Game', rows.map(r => r.Hurries / r.Games_Played));

db.close();
