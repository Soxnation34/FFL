// Ranks currently-available EDGE free agents (LDE/RDE, Designation='Unsigned', Team=99)
// by predicted Sacks/Game and Hurries/Game, using a model trained on the FULL CAREER
// panel of every current-roster EDGE player: each player's fixed Dash time paired with
// their season-by-season Pass_Rush_Technique rating, matched against that season's actual
// Sacks/Game and Hurries/Game. This is a much larger training set than a rookie-year-only
// model (every career season is an observation, not just year 1), which fit better.
//
// Pool: only free agents within +/-5 lbs of the position's ideal weight for the active
// scheme (ideal_weights_by_scheme, currently 4-3 Over) — same weight-fit filter as the
// standing draft scouting methodology. Also pulls in unsigned SLB/WLB free agents whose
// weight fits the target side as 'OLB->DE' conversion candidates.
// Usage: node scripts/rank_edge_free_agents.js
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'ffl.db'));
const MIN_GP = 8;

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
  return { beta, se, t, r2: 1 - ssr / sst, rmse: Math.sqrt(sigma2) };
}
function zscoreFit(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return { mean, sd, z: arr.map(v => (v - mean) / sd) };
}

// ---------- Build full-career training panel ----------
const edgePlayers = db.prepare(`
  SELECT pr.Player_ID, pr."40-Yard_Dash" AS Dash
  FROM player_record pr WHERE pr.Position IN ('LDE','RDE') AND pr."40-Yard_Dash" > 0
`).all();

const training = [];
for (const p of edgePlayers) {
  const seasons = db.prepare(`
    SELECT Year, Games_Played, "Sacks_(x10)" AS Sacks10, Hurries
    FROM player_year_summary WHERE Player_ID = ? AND Games_Played >= ?
  `).all(p.Player_ID, MIN_GP);
  for (const s of seasons) {
    const rating = db.prepare(`
      SELECT "Pass_Rush_Technique" AS PRT FROM player_ratings_season
      WHERE Player_ID = ? AND Year = ? AND Scouting = 'Exhibition'
    `).get(p.Player_ID, s.Year);
    if (!rating) continue;
    training.push({
      Dash: p.Dash, PRT: rating.PRT,
      sacksPerGame: (s.Sacks10 * 0.1) / s.Games_Played,
      hurriesPerGame: s.Hurries / s.Games_Played,
    });
  }
}
console.log(`Training panel: ${training.length} player-seasons from ${edgePlayers.length} current-roster EDGE players (GP>=${MIN_GP} each season, every career year included, not just rookie year)\n`);

function fitDeployable(targetFn) {
  const dashZ = zscoreFit(training.map(t => -t.Dash));
  const prtZ = zscoreFit(training.map(t => t.PRT));
  const X = training.map((t, i) => [1, dashZ.z[i], prtZ.z[i]]);
  const y = training.map(targetFn);
  const m = ols(X, y);
  return { m, dashZ, prtZ };
}
const sacksModel = fitDeployable(t => t.sacksPerGame);
const hurriesModel = fitDeployable(t => t.hurriesPerGame);

for (const [label, model] of [['Sacks/Game', sacksModel], ['Hurries/Game', hurriesModel]]) {
  console.log(`${label}: R^2=${model.m.r2.toFixed(3)}, RMSE=${model.m.rmse.toFixed(3)}`);
  console.log(`  Dash beta=${model.m.beta[1].toFixed(4)} t=${model.m.t[1].toFixed(2)}   PRT beta=${model.m.beta[2].toFixed(4)} t=${model.m.t[2].toFixed(2)}`);
}
console.log();

function predict(model, dash, prt) {
  const dz = (-dash - model.dashZ.mean) / model.dashZ.sd;
  const pz = (prt - model.prtZ.mean) / model.prtZ.sd;
  return Math.max(0, model.m.beta[0] + model.m.beta[1] * dz + model.m.beta[2] * pz);
}

// ---------- Rank the actual free-agent pool ----------
// Same weight-fit filter as the standing Edge Rusher scouting methodology (+/-5 lbs of the
// scheme-ideal weight from ideal_weights_by_scheme), and the same OLB->DE conversion logic:
// unsigned SLB/WLB free agents whose weight fits the target side are pulled in too.
const WEIGHT_TOLERANCE = 5;
const ideal = db.prepare(`SELECT Position_Code, Over_43 FROM ideal_weights_by_scheme WHERE Position_Code IN ('LDE','RDE')`).all();
const idealWeight = Object.fromEntries(ideal.map(r => [r.Position_Code, r.Over_43]));

// Free agents: Designation IN ('Unsigned', 'Unrestricted Free Agent'), Team != 22. NOTE: this
// previously only matched Designation='Unsigned' AND Team=99 — players with NO team at all
// (already released). That silently missed 'Unrestricted Free Agent', a separate, larger
// category: players free to sign but still showing their outgoing team's ID in Team (not 99).
// Team != 22 excludes the user's OWN Pittsburgh players who are pending free agents (a
// re-sign/retain decision, not an outside target).
function loadFAPool(side) {
  const target = idealWeight[side];
  const nativeSql = `
    SELECT pr.Player_ID, pi.Last_Name, pi.First_Name, pi.College, pi.Year_Born, pi.Weight,
           pr."40-Yard_Dash" AS Dash, pp.Current_Pass_Rush_Technique AS PRT, 'DE' AS role
    FROM player_record pr
    JOIN player_information pi ON pi.Player_ID = pr.Player_ID
    JOIN players_personal pp ON pp.Player_ID = pr.Player_ID
    WHERE pr.Position = ? AND pr.Designation IN ('Unsigned', 'Unrestricted Free Agent') AND pr.Team != 22
      AND pr."40-Yard_Dash" > 0 AND ABS(pi.Weight - ?) <= ?
  `;
  const natives = db.prepare(nativeSql).all(side, target, WEIGHT_TOLERANCE);

  const convertSql = `
    SELECT pr.Player_ID, pi.Last_Name, pi.First_Name, pi.College, pi.Year_Born, pi.Weight,
           pr."40-Yard_Dash" AS Dash, pp.Current_Pass_Rush_Technique AS PRT, 'OLB->DE' AS role
    FROM player_record pr
    JOIN player_information pi ON pi.Player_ID = pr.Player_ID
    JOIN players_personal pp ON pp.Player_ID = pr.Player_ID
    WHERE pr.Position IN ('SLB','WLB') AND pr.Designation IN ('Unsigned', 'Unrestricted Free Agent') AND pr.Team != 22
      AND pr."40-Yard_Dash" > 0 AND ABS(pi.Weight - ?) <= ?
  `;
  const converts = db.prepare(convertSql).all(target, WEIGHT_TOLERANCE);
  return [...natives, ...converts];
}

function rankFAs(side) {
  const fas = loadFAPool(side);
  fas.forEach(f => {
    f.predSacksPerGame = predict(sacksModel, f.Dash, f.PRT);
    f.predHurriesPerGame = predict(hurriesModel, f.Dash, f.PRT);
    f.predPressurePerGame = f.predSacksPerGame + f.predHurriesPerGame;
    f.weightDelta = f.Weight - idealWeight[side];
  });
  fas.sort((a, b) => b.predPressurePerGame - a.predPressurePerGame);

  console.log(`${'='.repeat(105)}\n${side} FREE AGENTS (ideal weight ${idealWeight[side]} lbs +/-${WEIGHT_TOLERANCE})  —  ${fas.length} available (${fas.filter(f=>f.role==='DE').length} native, ${fas.filter(f=>f.role==='OLB->DE').length} OLB convert), ranked by predicted production\n${'='.repeat(105)}`);
  console.log('#'.padEnd(3), 'Name'.padEnd(22), 'Role'.padEnd(8), 'Wt(d)'.padEnd(8), 'Born'.padEnd(6), 'Dash'.padEnd(6), 'PRT'.padEnd(5), 'Pred Sacks/G'.padEnd(13), 'Pred Hurries/G'.padEnd(15), '~17g season');
  fas.slice(0, 20).forEach((f, i) => {
    const name = `${f.First_Name} ${f.Last_Name}`;
    console.log(
      String(i + 1).padEnd(3), name.padEnd(22), f.role.padEnd(8),
      `${f.Weight}(${f.weightDelta>=0?'+':''}${f.weightDelta})`.padEnd(8),
      String(f.Year_Born).padEnd(6),
      (f.Dash / 100).toFixed(2).padEnd(6), String(f.PRT).padEnd(5),
      f.predSacksPerGame.toFixed(3).padEnd(13), f.predHurriesPerGame.toFixed(3).padEnd(15),
      `${(f.predSacksPerGame*17).toFixed(1)} sacks / ${(f.predHurriesPerGame*17).toFixed(1)} hur.`
    );
  });
  console.log();
}

rankFAs('LDE');
rankFAs('RDE');

db.close();
