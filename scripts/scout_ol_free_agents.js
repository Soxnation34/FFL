// OL FREE AGENT BREAKDOWN — same 5 positional buckets (C, LT, LG, RG, RT), weight-fit only.
// Mirrors scout_ol_prospects.js, but for the current free-agent pool instead of the draft
// class, showing the TOP 5 per bucket instead of top 10.
//
// Free agents: Designation IN ('Unsigned', 'Unrestricted Free Agent'). NOTE: an earlier version
// of this script (and rank_edge_free_agents.js) only matched Designation='Unsigned' AND Team=99,
// which is just players with NO team at all (already released) — 297 league-wide. That silently
// missed 'Unrestricted Free Agent' (251 league-wide), a separate, larger, MORE relevant category:
// players who are free to sign but still show their outgoing team's ID in Team (not 99). Real
// targets like Cooper Kerby and C.J. Benner (both Centers) were invisible under the old filter.
// 'Restricted' (needs a tender/compensation, original team can match) is excluded from the main
// board and reported separately. 'Franchised' is not a free agent at all.
//
// Key difference from the draft version: free agents are established players with a REAL
// Current_Run_Blocking rating already on file — there's no scout Low/High range to blend
// with a data model (draft_personal only covers the current draft class), so Run_Blocking
// here is their actual measured rating, not a prediction. The Dash->Run_Blocking model from
// the draft pipeline (r=-0.732) is still shown for reference/cross-check only. Expected_KRB
// and Expected_BPct are then derived from their REAL Run_Blocking via the same
// Run_Blocking->stat regressions established in ol_krb_bpct_drivers.js.
//
// Position-agnostic pool (current position doesn't gate bucket eligibility) and Solecismic
// >= 30 filter, same as the draft board.
// Usage: node scripts/scout_ol_free_agents.js
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
  return { beta, se, t, r2: 1 - ssr / sst };
}
function zscore(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return arr.map(v => (v - mean) / sd);
}

// ============================================================================
// Fit models (same as scout_ol_prospects.js)
// ============================================================================
const histRunB = db.prepare(`
  SELECT pr."40-Yard_Dash" AS Dash, pp.Current_Run_Blocking AS RunB
  FROM player_record pr JOIN players_personal pp ON pp.Player_ID = pr.Player_ID
  WHERE pr.Position IN ('LT','LG','C','RG','RT') AND pr."40-Yard_Dash" > 0 AND pp.Current_Run_Blocking > 0
`).all();
const mDash = ols(histRunB.map(r => [1, r.Dash]), histRunB.map(r => r.RunB));
function dashModelRunBlock(dash) { return Math.max(0, Math.min(100, mDash.beta[0] + mDash.beta[1] * dash)); }

const seasonRows = db.prepare(`
  SELECT Games_Played, Key_Run_Blocks, Block_Opportunities, Run_Blocking
  FROM player_year_summary
  WHERE Position IN ('LT','LG','C','RG','RT') AND Current_Overall > 0 AND Games_Played >= 4 AND Block_Opportunities >= 20
`).all();
const RunBArr = seasonRows.map(r => r.Run_Blocking);
const mKRB = ols(seasonRows.map((_, i) => [1, RunBArr[i]]), seasonRows.map(r => r.Key_Run_Blocks / r.Games_Played));
const mBPct = ols(seasonRows.map((_, i) => [1, RunBArr[i]]), seasonRows.map(r => 100 * r.Key_Run_Blocks / r.Block_Opportunities));
console.log(`Reference model (n=${histRunB.length}): Dash -> Run_Blocking, R^2=${mDash.r2.toFixed(3)} (shown for cross-check only — real ratings used below)`);
console.log(`Stage models (n=${seasonRows.length}): Run_Blocking -> KRB/Game (R^2=${mKRB.r2.toFixed(3)}), Run_Blocking -> BPct (R^2=${mBPct.r2.toFixed(3)})\n`);
function krbModel(rb) { return mKRB.beta[0] + mKRB.beta[1] * rb; }
function bpctModel(rb) { return mBPct.beta[0] + mBPct.beta[1] * rb; }

// ============================================================================
// Load free agent OL pool
// ============================================================================
const MIN_SOLECISMIC = 30;
// Note: player_information.College is a numeric code with no decode table for veteran
// players (only the draft-class rookies.csv has real college names — see the footer of
// Free_Agent_Cheat_Sheet.md) — so we show Age (from Year_Born) instead, same convention.
// Team=22 (Pittsburgh) is excluded here even when Designation='Unrestricted Free Agent' —
// those are the user's OWN players heading toward free agency (a re-sign/retain decision),
// not outside targets to poach.
const faSql = `
  SELECT pr.Player_ID, pi.Last_Name, pi.First_Name, pi.Year_Born, pi.Weight, pr.Position AS CurrentPos, pr.Designation, pr.Team,
         pr."40-Yard_Dash" AS Dash, pr.Solecismic_Test AS Solecismic,
         pp.Current_Run_Blocking AS RunBlock, pp.Current_Overall AS OA
  FROM player_record pr
  JOIN player_information pi ON pi.Player_ID = pr.Player_ID
  JOIN players_personal pp ON pp.Player_ID = pr.Player_ID
  WHERE pr.Position IN ('LT','LG','C','RG','RT') AND pr.Designation IN ('Unsigned', 'Unrestricted Free Agent')
    AND pr.Team != 22
    AND pr."40-Yard_Dash" > 0 AND pr.Solecismic_Test >= ${MIN_SOLECISMIC}
`;
const allFAs = db.prepare(faSql).all().map(p => ({
  ...p,
  rb_dashModel: dashModelRunBlock(p.Dash),
  krb_expected: krbModel(p.RunBlock),
  bpct_expected: bpctModel(p.RunBlock),
}));
console.log(`n=${allFAs.length} free-agent OL with Solecismic >= ${MIN_SOLECISMIC} and a worked-out 40 time (of 49 total unsigned T/G/C)\n`);

// ============================================================================
// 5 buckets: weight-fit only, +/-10 lbs of ideal, position-agnostic, top 5 each
// ============================================================================
const BUCKETS = [
  { label: 'CENTER', code: 'C' },
  { label: 'LEFT TACKLE', code: 'LT' },
  { label: 'LEFT GUARD', code: 'LG' },
  { label: 'RIGHT GUARD', code: 'RG' },
  { label: 'RIGHT TACKLE', code: 'RT' },
];
const idealRows = db.prepare(`SELECT Position_Code, Offense FROM ideal_weights_by_scheme WHERE Position_Code IN ('C','LT','LG','RG','RT')`).all();
const idealWeight = Object.fromEntries(idealRows.map(r => [r.Position_Code, r.Offense]));
const TOLERANCE = 10;

for (const bucket of BUCKETS) {
  const target = idealWeight[bucket.code];
  const pool = allFAs.filter(p => Math.abs(p.Weight - target) <= TOLERANCE);

  console.log('='.repeat(108));
  console.log(`${bucket.label}  (ideal weight ${target} lbs, +/-${TOLERANCE})  —  ${pool.length} qualify`);
  console.log('='.repeat(108));

  if (pool.length === 0) { console.log('  (none)\n'); continue; }

  const krbZ = zscore(pool.map(p => p.krb_expected));
  const bpctZ = zscore(pool.map(p => p.bpct_expected));
  const rbZ = zscore(pool.map(p => p.RunBlock));
  const dashZ = zscore(pool.map(p => -p.Dash));
  pool.forEach((p, i) => {
    p.score = ((krbZ[i] + bpctZ[i]) / 2 + rbZ[i] + dashZ[i]) / 3;
    p.weightDelta = p.Weight - target;
  });
  pool.sort((a, b) => b.score - a.score);

  console.log(
    '#'.padEnd(3), 'Name'.padEnd(22), 'Pos'.padEnd(4), 'Wt (delta)'.padEnd(11),
    'Dash'.padEnd(6), 'Solec'.padEnd(6), 'RunBlock'.padEnd(9), 'Dash Model'.padEnd(11),
    'Exp KRB/G'.padEnd(10), 'Exp BPct'.padEnd(9), 'Overall'.padEnd(8), 'Born'
  );
  pool.slice(0, 5).forEach((p, i) => {
    const name = `${p.First_Name} ${p.Last_Name}`;
    const dashStr = (p.Dash / 100).toFixed(2);
    console.log(
      String(i + 1).padEnd(3),
      name.padEnd(22),
      p.CurrentPos.padEnd(4),
      `${p.Weight} (${p.weightDelta >= 0 ? '+' : ''}${p.weightDelta})`.padEnd(11),
      dashStr.padEnd(6),
      String(p.Solecismic).padEnd(6),
      String(p.RunBlock).padEnd(9),
      p.rb_dashModel.toFixed(0).padEnd(11),
      p.krb_expected.toFixed(2).padEnd(10),
      p.bpct_expected.toFixed(1).padEnd(9),
      String(p.OA).padEnd(8),
      p.Year_Born
    );
  });
  console.log();
}

db.close();
