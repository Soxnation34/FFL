// QUARTERBACK MODEL — combine-blended Expected attributes + veteran-ceiling stat projections
// + Avoid_Interception (added 2026-08-10).
// Same architecture as rb/dl/ol/db_card_model.js, extracted from scout_qb_sleepers.js so a
// single Player_ID lookup is reusable (that script only ever printed a top-15 board directly).
// Formulas are copied verbatim from scout_qb_sleepers.js — do not re-derive independently.
//
// AVOID_INTERCEPTION (AI): community-derived formula (tzachfootball's Avoid Int. Calculator),
// verified against this league's own data 2026-08-10. Current_Overall for QB is a hidden
// weighted sum of 11 sub-ratings — the same "no-intercept weighted average" pattern already
// confirmed for DL/DB Overall (see Draft_Methodology.md) — and AI is the one term of the 11
// that ISN'T shown anywhere on the in-game ratings screen:
//   Overall = 0.082*Screen + 0.078*Short + 0.091*Med + 0.091*Long + 0.062*Deep + 0.099*ThirdDown
//           + 0.095*Acc + 0.033*SenseRush + 0.045*ReadD + 0.029*Twomin + 0.296*AI
// (weights sum to 1.000 - 0.001 rounding). Solving for AI is just isolating the one unknown term.
// Validated on 105 rostered QBs (scripts/avoid_int_check.js): every computed AI landed inside
// the valid 0-100 range (0 out-of-bounds — strong structural evidence the weights are right),
// and AI correlates NEGATIVELY with real INT rate (Intercepted/Pass_Attempts, 2075 season,
// Att>=100, n=37): r=-0.35. Moderate, not tight, consistent with the established QB rating-vs-
// production lag (cfl_position_aging_curves memory) — INT rate isn't driven by one rating alone.
//
// For ROSTERED QBs, AI is EXACT (real Current_Overall + real Current_* sub-ratings in, no
// estimation). For DRAFT PROSPECTS, Overall itself isn't known pre-league — only Grade (the
// scout's composite estimate) — so AI is estimated by substituting Grade for Overall. This is
// the SAME assumption already made elsewhere in this file (tier: Grade>=56 = Top), and was
// independently screen-confirmed accurate for DL (Grade 69 vs formula 68.7), but has NOT been
// separately verified for QB specifically — treat prospect AI as a reasonable estimate, not an
// exact figure the way the veteran AI is. The Low/High range on a prospect's AI comes from
// propagating the OTHER 10 ratings' scout Low/High through the formula while holding Grade
// fixed: since every weight is positive and subtracted, AI is maximized when the other 10 sit
// at their scout LOW bound and minimized when they sit at their HIGH bound (not from any
// Low_Avoid_Interception/High_Avoid_Interception column — no such column exists, scouts don't
// grade this trait directly, same reason it's hidden in-game).
//
// Usage: node scripts/qb_card_model.js <Player_ID>        (draft prospect)
//        node scripts/qb_card_model.js <Player_ID> vet     (rostered veteran)
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'ffl.db'));

function ols(X, y) {
  const n = X.length, p = X[0].length;
  const XtX = Array.from({ length: p }, () => Array(p).fill(0));
  const Xty = Array(p).fill(0);
  for (let i = 0; i < n; i++) { for (let a = 0; a < p; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b]; } }
  const n2 = p;
  const A = XtX.map((row, i) => [...row, ...Array.from({ length: n2 }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n2; col++) {
    let piv = col;
    for (let r = col + 1; r < n2; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const pv = A[col][col];
    for (let c = 0; c < 2 * n2; c++) A[col][c] /= pv;
    for (let r = 0; r < n2; r++) { if (r === col) continue; const f = A[r][col]; for (let c = 0; c < 2 * n2; c++) A[r][c] -= f * A[col][c]; }
  }
  const inv = A.map(row => row.slice(n2));
  const beta = inv.map(row => row.reduce((s, v, k) => s + v * Xty[k], 0));
  let ssr = 0, sst = 0; const ymean = y.reduce((a, b) => a + b, 0) / n;
  const fitted = X.map(row => row.reduce((s, v, k) => s + v * beta[k], 0));
  for (let i = 0; i < n; i++) { ssr += (y[i] - fitted[i]) ** 2; sst += (y[i] - ymean) ** 2; }
  return { beta, r2: 1 - ssr / sst };
}

// ---------- Avoid_Interception ----------
const AI_WEIGHTS = {
  Screen: 0.082, Short: 0.078, Med: 0.091, Long: 0.091, Deep: 0.062,
  ThirdDown: 0.099, Acc: 0.095, SenseRush: 0.033, ReadD: 0.045, Twomin: 0.029,
};
const AI_SELF_WEIGHT = 0.296;
function computeAvoidInt(r) {
  const knownSum = Object.entries(AI_WEIGHTS).reduce((s, [k, w]) => s + w * r[k], 0);
  const raw = (r.Overall - knownSum) / AI_SELF_WEIGHT;
  return Math.max(0, Math.min(100, raw));
}

// ---------- Combine (Bench_Press) -> ratings models ----------
const histCombine = db.prepare(`
  SELECT pr.Bench_Press AS Bench, pp.Current_Deep_Passes AS DeepP, pp."Current_Long_Passes" AS LongP, pp.Current_Accuracy AS Acc
  FROM player_record pr JOIN players_personal pp ON pp.Player_ID = pr.Player_ID
  WHERE pr.Position='QB' AND pr."40-Yard_Dash">0 AND pp.Current_Deep_Passes>0
`).all();
const mDeepFromBench = ols(histCombine.map(r => [1, r.Bench]), histCombine.map(r => r.DeepP));
const mLongFromBench = ols(histCombine.map(r => [1, r.Bench]), histCombine.map(r => r.LongP));
const mAccFromBench = ols(histCombine.map(r => [1, r.Bench]), histCombine.map(r => r.Acc));
function benchModelDeep(bench) { return Math.max(0, Math.min(100, mDeepFromBench.beta[0] + mDeepFromBench.beta[1] * bench)); }
function benchModelLong(bench) { return Math.max(0, Math.min(100, mLongFromBench.beta[0] + mLongFromBench.beta[1] * bench)); }
function benchModelAcc(bench) { return Math.max(0, Math.min(100, mAccFromBench.beta[0] + mAccFromBench.beta[1] * bench)); }

// ---------- Ratings -> stats, VETERAN-ONLY (Experience >= 5) ----------
const VETERAN_EXP_MIN = 5;
const seasonRows = db.prepare(`
  SELECT pys.Pass_Attempts, pys.Pass_Completions, pys.Passing_Yards, pys."20-Yard_Completions" AS TwentyYd, pys.Accuracy, pys.Deep_Passes AS DeepP
  FROM player_year_summary pys JOIN player_information pi ON pi.Player_ID = pys.Player_ID
  WHERE pys.Position='QB' AND pys.Current_Overall>0 AND pys.Games_Played>=4 AND pys.Pass_Attempts>=100
    AND pi.Draft_Year>0 AND (pys.Year - pi.Draft_Year) >= ${VETERAN_EXP_MIN}
`).all();
const avgAArr = seasonRows.map(r => r.Passing_Yards / r.Pass_Attempts);
const deepRateArr = seasonRows.map(r => r.TwentyYd / r.Pass_Completions);
const XStats = seasonRows.map(r => [1, r.Accuracy, r.DeepP]);
const mAvgA = ols(XStats, avgAArr);
const mDeepRate = ols(XStats, deepRateArr);
function predictAvgA(acc, deepP) { return mAvgA.beta[0] + mAvgA.beta[1] * acc + mAvgA.beta[2] * deepP; }
function predictDeepRate(acc, deepP) { return mDeepRate.beta[0] + mDeepRate.beta[1] * acc + mDeepRate.beta[2] * deepP; }

// ---------- INT rate, veteran-ceiling (Experience >= 5), driven by AI ----------
const intRows = db.prepare(`
  SELECT pys.Player_ID, pys.Pass_Attempts, pys.Intercepted,
    pp.Current_Overall AS Overall, pp.Current_Screen_Passes AS Screen, pp.Current_Short_Passes AS Short,
    pp.Current_Medium_Passes AS Med, pp.Current_Long_Passes AS Long, pp.Current_Deep_Passes AS Deep,
    pp.Current_Third_Down AS ThirdDown, pp.Current_Accuracy AS Acc, pp.Current_Sense_Rush AS SenseRush,
    pp.Current_Read_Defense AS ReadD, pp."Current_Two-Minute_Offense" AS Twomin
  FROM player_year_summary pys
  JOIN player_information pi ON pi.Player_ID = pys.Player_ID
  JOIN players_personal pp ON pp.Player_ID = pys.Player_ID
  WHERE pys.Position='QB' AND pys.Games_Played>=4 AND pys.Pass_Attempts>=100 AND pp.Current_Overall>0
    AND pi.Draft_Year>0 AND (pys.Year - pi.Draft_Year) >= ${VETERAN_EXP_MIN}
`).all().map(r => ({ ...r, AI: computeAvoidInt(r), intPct: 100 * r.Intercepted / r.Pass_Attempts }));
const mIntPct = ols(intRows.map(r => [1, r.AI]), intRows.map(r => r.intPct));
function predictIntPct(ai) { return Math.max(0, mIntPct.beta[0] + mIntPct.beta[1] * ai); }

const SLEEPER_GRADE_CEILING = 56;

// ---------- Draft prospect card ----------
function computeCard(playerId) {
  const p = db.prepare(`
    SELECT r.Player_ID, r.Last_Name, r.First_Name, r.College, r.Weight, r.Dash, r.Strength AS Bench, r.Grade,
           dp."Low_Accuracy" AS acc_lo, dp."High_Accuracy" AS acc_hi,
           dp."Low_Deep_Passes" AS deep_lo, dp."High_Deep_Passes" AS deep_hi,
           dp."Low_Long_Passes" AS long_lo, dp."High_Long_Passes" AS long_hi,
           dp."Low_Screen_Passes" AS screen_lo, dp."High_Screen_Passes" AS screen_hi,
           dp."Low_Short_Passes" AS short_lo, dp."High_Short_Passes" AS short_hi,
           dp."Low_Medium_Passes" AS med_lo, dp."High_Medium_Passes" AS med_hi,
           dp."Low_Third_Down" AS td_lo, dp."High_Third_Down" AS td_hi,
           dp."Low_Sense_Rush" AS sr_lo, dp."High_Sense_Rush" AS sr_hi,
           dp."Low_Read_Defense" AS rd_lo, dp."High_Read_Defense" AS rd_hi,
           dp."Low_Two-Minute_Offense" AS tm_lo, dp."High_Two-Minute_Offense" AS tm_hi
    FROM rookies r JOIN draft_personal dp ON dp.Player_ID = r.Player_ID
    WHERE r.Player_ID = ? AND r.Position_Group = 'QB'
  `).get(playerId);
  if (!p) throw new Error(`Player_ID ${playerId} not found or not QB.`);

  const mid = (lo, hi) => (lo + hi) / 2;
  const acc_mid = mid(p.acc_lo, p.acc_hi), deep_mid = mid(p.deep_lo, p.deep_hi), long_mid = mid(p.long_lo, p.long_hi);
  const untested = p.Dash === 0;
  const acc_expected = untested ? acc_mid : (acc_mid + benchModelAcc(p.Bench)) / 2;
  const deep_expected = untested ? deep_mid : (deep_mid + benchModelDeep(p.Bench)) / 2;
  const long_expected = untested ? long_mid : (long_mid + benchModelLong(p.Bench)) / 2;

  // Avoid_Interception: Grade stands in for Overall (unverified assumption for QB, see header).
  // Expected = plug in Expected/midpoint values for the other 10. Lo/Hi = propagate each of
  // those 10 ratings' own scout range through the (all-positive-weight) formula.
  const screen_mid = mid(p.screen_lo, p.screen_hi), short_mid = mid(p.short_lo, p.short_hi), med_mid = mid(p.med_lo, p.med_hi);
  const td_mid = mid(p.td_lo, p.td_hi), sr_mid = mid(p.sr_lo, p.sr_hi), rd_mid = mid(p.rd_lo, p.rd_hi), tm_mid = mid(p.tm_lo, p.tm_hi);
  const base = { Overall: p.Grade };
  const aiExpected = computeAvoidInt({ ...base, Screen: screen_mid, Short: short_mid, Med: med_mid, Long: long_expected, Deep: deep_expected, ThirdDown: td_mid, Acc: acc_expected, SenseRush: sr_mid, ReadD: rd_mid, Twomin: tm_mid });
  const aiAtLowBounds = computeAvoidInt({ ...base, Screen: p.screen_lo, Short: p.short_lo, Med: p.med_lo, Long: p.long_lo, Deep: p.deep_lo, ThirdDown: p.td_lo, Acc: p.acc_lo, SenseRush: p.sr_lo, ReadD: p.rd_lo, Twomin: p.tm_lo });
  const aiAtHighBounds = computeAvoidInt({ ...base, Screen: p.screen_hi, Short: p.short_hi, Med: p.med_hi, Long: p.long_hi, Deep: p.deep_hi, ThirdDown: p.td_hi, Acc: p.acc_hi, SenseRush: p.sr_hi, ReadD: p.rd_hi, Twomin: p.tm_hi });
  const ai_hi = aiAtLowBounds, ai_lo = aiAtHighBounds; // AI is decreasing in every other rating

  return {
    player: `${p.First_Name} ${p.Last_Name}`,
    college: p.College,
    position: 'QB',
    weight: p.Weight,
    dash: p.Dash,
    grade: p.Grade,
    untested,
    tier: p.Grade < SLEEPER_GRADE_CEILING ? 'Sleeper' : 'Top',
    attributes: {
      Accuracy: { lo: p.acc_lo, hi: p.acc_hi, expected: acc_expected },
      Deep_Passes: { lo: p.deep_lo, hi: p.deep_hi, expected: deep_expected },
      Long_Passes: { lo: p.long_lo, hi: p.long_hi, expected: long_expected },
      Avoid_Interception: { lo: ai_lo, hi: ai_hi, expected: aiExpected, estimatedFromGrade: true },
    },
    projections: {
      avgYardsPerAttempt: predictAvgA(acc_expected, deep_expected),
      deepRate: predictDeepRate(acc_expected, deep_expected),
      intPct: predictIntPct(aiExpected),
    },
  };
}

// ---------- Rostered veteran card ----------
function computeVeteranCard(playerId) {
  const pr = db.prepare(`
    SELECT pr.Player_ID, pi.First_Name, pi.Last_Name, pr.Team, pr.Experience,
      pp.Current_Overall AS Overall, pp.Current_Screen_Passes AS Screen, pp.Current_Short_Passes AS Short,
      pp.Current_Medium_Passes AS Med, pp.Current_Long_Passes AS Long, pp.Current_Deep_Passes AS Deep,
      pp.Current_Third_Down AS ThirdDown, pp.Current_Accuracy AS Acc, pp.Current_Sense_Rush AS SenseRush,
      pp.Current_Read_Defense AS ReadD, pp."Current_Two-Minute_Offense" AS Twomin
    FROM player_record pr
    JOIN player_information pi ON pi.Player_ID = pr.Player_ID
    JOIN players_personal pp ON pp.Player_ID = pr.Player_ID
    WHERE pr.Player_ID = ? AND pr.Position = 'QB'
  `).get(playerId);
  if (!pr) throw new Error(`Player_ID ${playerId} not found or not a rostered QB.`);

  const ai = computeAvoidInt(pr);
  const lastSeason = db.prepare(`
    SELECT Year, Games_Played, Pass_Attempts, Pass_Completions, Passing_Yards, Touchdown_Passes, Intercepted
    FROM player_year_summary WHERE Player_ID = ? AND Pass_Attempts > 0 ORDER BY Year DESC LIMIT 1
  `).get(playerId);

  return {
    player: `${pr.First_Name} ${pr.Last_Name}`,
    position: 'QB',
    team: pr.Team,
    experience: pr.Experience,
    overall: pr.Overall,
    attributes: {
      Screen_Passes: pr.Screen, Short_Passes: pr.Short, Medium_Passes: pr.Med, Long_Passes: pr.Long,
      Deep_Passes: pr.Deep, Third_Down: pr.ThirdDown, Accuracy: pr.Acc, Sense_Rush: pr.SenseRush,
      Read_Defense: pr.ReadD, Two_Minute_Offense: pr.Twomin, Avoid_Interception: ai,
    },
    lastSeason: lastSeason ? {
      year: lastSeason.Year, gamesPlayed: lastSeason.Games_Played,
      passAttempts: lastSeason.Pass_Attempts, passCompletions: lastSeason.Pass_Completions,
      passingYards: lastSeason.Passing_Yards, touchdownPasses: lastSeason.Touchdown_Passes,
      interceptions: lastSeason.Intercepted,
      intPct: 100 * lastSeason.Intercepted / lastSeason.Pass_Attempts,
    } : null,
  };
}

if (require.main === module) {
  console.log(`Combine model (n=${histCombine.length}): Bench_Press -> Deep_Passes, R^2=${mDeepFromBench.r2.toFixed(3)}`);
  console.log(`Combine model (n=${histCombine.length}): Bench_Press -> Long_Passes, R^2=${mLongFromBench.r2.toFixed(3)}`);
  console.log(`Combine model (n=${histCombine.length}): Bench_Press -> Accuracy, R^2=${mAccFromBench.r2.toFixed(3)}`);
  console.log(`Stage 2, VETERAN-ONLY Experience>=${VETERAN_EXP_MIN} (n=${seasonRows.length}): Avg/A R^2=${mAvgA.r2.toFixed(3)}, DeepRate R^2=${mDeepRate.r2.toFixed(3)}`);
  console.log(`Avoid_Interception -> INT%, VETERAN-ONLY Experience>=${VETERAN_EXP_MIN} (n=${intRows.length}): IntPct = ${mIntPct.beta[0].toFixed(3)} + ${mIntPct.beta[1].toFixed(4)}*AI, R^2=${mIntPct.r2.toFixed(3)}`);
  const pid = process.argv[2] ? Number(process.argv[2]) : null;
  const mode = process.argv[3];
  if (pid) {
    const card = mode === 'vet' ? computeVeteranCard(pid) : computeCard(pid);
    console.log('\n' + JSON.stringify(card, null, 2));
  }
}

module.exports = { computeCard, computeVeteranCard, computeAvoidInt, AI_WEIGHTS, AI_SELF_WEIGHT };
