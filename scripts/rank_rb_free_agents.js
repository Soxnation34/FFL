// Ranks currently-available RB free agents by predicted Yards/Game, Avg (YPC), and 10+R rate,
// using a model trained on the full historical season panel (player_year_summary, Position='RB',
// Current_Overall>0, Games_Played>=4, Rushes>=20 — n=2705, see rb_yards_avg_explosive_drivers.js)
// where Current_Overall, Hole_Recognition, and Elusiveness are the two established real drivers
// (Hole_Recognition for Yards/Game and Avg, Elusiveness for 10+R rate).
//
// Unlike the draft-prospect RB board, free agents are established players with REAL current
// ratings already on file — no scout-range blending needed, same as the OL/Edge free agent
// pipelines. Predicts each FA's expected production directly from their actual Overall/HR/Elus.
//
// Free agents: Designation IN ('Unsigned', 'Unrestricted Free Agent'), Team != 22 (excludes the
// user's own Pittsburgh pending free agents — a retention decision, not outside targets).
// Usage: node scripts/rank_rb_free_agents.js
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'ffl.db'));

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
  for (let i = 0; i < n; i++) { for (let a = 0; a < p; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b]; } }
  const inv = matInv(XtX);
  const beta = inv.map(row => row.reduce((s, v, k) => s + v * Xty[k], 0));
  let ssr = 0, sst = 0; const ymean = y.reduce((a, b) => a + b, 0) / n;
  const fitted = X.map(row => row.reduce((s, v, k) => s + v * beta[k], 0));
  for (let i = 0; i < n; i++) { ssr += (y[i] - fitted[i]) ** 2; sst += (y[i] - ymean) ** 2; }
  const sigma2 = ssr / (n - p);
  const se = inv.map((row, i) => Math.sqrt(sigma2 * row[i]));
  const t = beta.map((b, i) => b / se[i]);
  return { beta, se, t, r2: 1 - ssr / sst, rmse: Math.sqrt(sigma2) };
}
function zscoreFit(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return { mean, sd, z: arr.map(v => (v - mean) / sd) };
}

// ---------- Training panel: historical RB seasons ----------
const training = db.prepare(`
  SELECT Games_Played, Rushes, Rushing_Yards, "10-Yard_Runs" AS TenR,
         Current_Overall AS OA, Hole_Recognition AS HR, Elusiveness AS Elus
  FROM player_year_summary
  WHERE Position='RB' AND Current_Overall > 0 AND Games_Played >= 4 AND Rushes >= 20
`).all();
console.log(`Training panel: ${training.length} historical RB seasons\n`);

function fitDeployable(targetFn) {
  const oaZ = zscoreFit(training.map(t => t.OA));
  const hrZ = zscoreFit(training.map(t => t.HR));
  const elusZ = zscoreFit(training.map(t => t.Elus));
  const X = training.map((t, i) => [1, oaZ.z[i], hrZ.z[i], elusZ.z[i]]);
  const y = training.map(targetFn);
  const m = ols(X, y);
  return { m, oaZ, hrZ, elusZ };
}
const yardsModel = fitDeployable(t => t.Rushing_Yards / t.Games_Played);
const avgModel = fitDeployable(t => t.Rushing_Yards / t.Rushes);
const tenRModel = fitDeployable(t => t.TenR / t.Rushes);

for (const [label, model] of [['Yards/Game', yardsModel], ['Avg (YPC)', avgModel], ['10+R rate', tenRModel]]) {
  console.log(`${label}: R^2=${model.m.r2.toFixed(3)}, RMSE=${model.m.rmse.toFixed(3)}`);
  console.log(`  Overall beta=${model.m.beta[1].toFixed(4)} t=${model.m.t[1].toFixed(2)}   HR beta=${model.m.beta[2].toFixed(4)} t=${model.m.t[2].toFixed(2)}   Elus beta=${model.m.beta[3].toFixed(4)} t=${model.m.t[3].toFixed(2)}`);
}
console.log();

function predict(model, oa, hr, elus) {
  const oz = (oa - model.oaZ.mean) / model.oaZ.sd;
  const hz = (hr - model.hrZ.mean) / model.hrZ.sd;
  const ez = (elus - model.elusZ.mean) / model.elusZ.sd;
  return Math.max(0, model.m.beta[0] + model.m.beta[1] * oz + model.m.beta[2] * hz + model.m.beta[3] * ez);
}

// ---------- Load and rank the actual free-agent pool ----------
const faSql = `
  SELECT pr.Player_ID, pi.Last_Name, pi.First_Name, pi.Year_Born, pi.Weight, pr.Designation, pr.Team,
         pp.Current_Overall AS OA, pp.Current_Hole_Recognition AS HR, pp.Current_Elusiveness AS Elus
  FROM player_record pr
  JOIN player_information pi ON pi.Player_ID = pr.Player_ID
  JOIN players_personal pp ON pp.Player_ID = pr.Player_ID
  WHERE pr.Position = 'RB' AND pr.Designation IN ('Unsigned', 'Unrestricted Free Agent') AND pr.Team != 22
`;
const fas = db.prepare(faSql).all();
fas.forEach(f => {
  f.predYardsPerGame = predict(yardsModel, f.OA, f.HR, f.Elus);
  f.predAvg = predict(avgModel, f.OA, f.HR, f.Elus);
  f.predTenRRate = predict(tenRModel, f.OA, f.HR, f.Elus);
});

// Composite: equal weight, z-scored within the pool
function zscore(arr) {
  const n = arr.length; const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return arr.map(v => (v - mean) / sd);
}
const yZ = zscore(fas.map(f => f.predYardsPerGame));
const aZ = zscore(fas.map(f => f.predAvg));
const tZ = zscore(fas.map(f => f.predTenRRate));
fas.forEach((f, i) => f.score = (yZ[i] + aZ[i] + tZ[i]) / 3);
fas.sort((a, b) => b.score - a.score);

console.log(`${'='.repeat(110)}\nRB FREE AGENTS  —  ${fas.length} available, ranked by predicted production\n${'='.repeat(110)}`);
console.log('#'.padEnd(3), 'Name'.padEnd(22), 'Wt'.padEnd(5), 'Born'.padEnd(6), 'OA'.padEnd(4), 'HR'.padEnd(4), 'Elus'.padEnd(5), 'Pred Yds/G'.padEnd(11), 'Pred Avg'.padEnd(9), 'Pred 10+R%'.padEnd(11));
fas.slice(0, 25).forEach((f, i) => {
  const name = `${f.First_Name} ${f.Last_Name}`;
  console.log(
    String(i + 1).padEnd(3), name.padEnd(22), String(f.Weight).padEnd(5), String(f.Year_Born).padEnd(6),
    String(f.OA).padEnd(4), String(f.HR).padEnd(4), String(f.Elus).padEnd(5),
    f.predYardsPerGame.toFixed(2).padEnd(11), f.predAvg.toFixed(2).padEnd(9), (100 * f.predTenRRate).toFixed(1).padEnd(11)
  );
});

// ---------- Compare against Pittsburgh's current roster (using the same model) ----------
console.log(`\n${'='.repeat(110)}\nPITTSBURGH CURRENT RB ROSTER (same model, for comparison)\n${'='.repeat(110)}`);
const pitRBs = db.prepare(`
  SELECT pi.First_Name, pi.Last_Name, pr.Designation, pp.Current_Overall AS OA, pp.Current_Hole_Recognition AS HR, pp.Current_Elusiveness AS Elus
  FROM player_record pr JOIN player_information pi ON pi.Player_ID=pr.Player_ID JOIN players_personal pp ON pp.Player_ID=pr.Player_ID
  WHERE pr.Team=22 AND pr.Position='RB'
`).all();
pitRBs.forEach(p => {
  const yds = predict(yardsModel, p.OA, p.HR, p.Elus);
  const avg = predict(avgModel, p.OA, p.HR, p.Elus);
  const ten = predict(tenRModel, p.OA, p.HR, p.Elus);
  console.log(`${(p.First_Name + ' ' + p.Last_Name).padEnd(20)} [${p.Designation}]  OA=${p.OA} HR=${p.HR} Elus=${p.Elus}  Pred Yds/G=${yds.toFixed(2)} Pred Avg=${avg.toFixed(2)} Pred 10+R%=${(100 * ten).toFixed(1)}`);
});

db.close();
