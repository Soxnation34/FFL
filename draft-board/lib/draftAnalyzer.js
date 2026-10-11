// Faithful reimplementation of StelmackSoft DraftAnalyzer's Rating/CombineSum calculation.
//
// Reverse-engineered directly from the tool's actual C# source (not guessed): see
// C:\Users\soxna\OneDrive\FOF8 Utilities\FOFUtilities-master\DataReader\DraftWeights.cs,
// DataReader\FOFData.cs, and DraftAnalyzer\DraftAnalyzerForm.cs. Every table below was checked
// against the user's real weights file at C:\Users\soxna\OneDrive\Documents\StelmackSoft\
// UtilitySuite\DraftAnalyzer.weights byte-for-byte (its 28 per-position weight blocks and its
// 12-field global-settings header all match these exact source defaults, unmodified — confirmed
// 2026-08-09) and against ffl.db's ideal_weights_by_scheme table (identical ideal-weight numbers).
//
// Formula (DraftAnalyzerForm.CalculatePositionRating / CalculateCombineRating, ~line 963-1127):
//   OverallScore = (CombineScore + SizeScore + AttributeScore + DevelopmentScore) * posWeight.Weight
//
//   CombineScore = sum over {Dash, Solecismic, Bench, Agility, BroadJump, PositionDrill} of either
//     a flat -100 threshold penalty (if the group's threshold for that channel is set and the
//     prospect's raw value crosses it the wrong way), or ((value - groupAvg) / groupStdDev) *
//     positionWeight — where groupAvg/groupStdDev/threshold are FIXED, hardcoded per-position-
//     GROUP constants (NOT recomputed from the live draft class), keyed by the prospect's NATIVE
//     position group, while positionWeight comes from whichever position is currently being
//     tested (native, or a cross-rated alternate). Dash and Agility use a negated stddev, since
//     lower is better on those two drills. If the prospect is missing any of
//     {Solecismic,Dash,Bench,Agility,BroadJump} (0 = not yet combine-tested), a degraded
//     "no-combine" weight set is used instead (only Solecismic + PositionDrill contribute) — this
//     is a real, intentional fallback in the tool, not an error state, and untested prospects are
//     never excluded from the board because of it.
//
//   SizeScore = (height - candidatePosition.avgHeight) * heightFactor
//             - |weight - idealWeight(candidatePosition, scheme)| * weightFactor
//     (Scheme is passed in by the caller via idealWeightLookup — pools.js currently fixes this to
//     4-3 Over, the user's actual defense, overriding the True-34 value saved in the .weights
//     file's header, which only reflects whatever the desktop UI last had selected.)
//
//   AttributeScore = sum over the candidate position's up to 15 named sub-ratings of
//     (Low + High) * normalizedWeight * 0.005 ("UseAverage" mode, the confirmed active setting).
//
//   DevelopmentScore = (Developed% - 30) * (10/30)   [global AvgDev=30, DevWt=10 defaults]
//
//   ChemistryScore is OMITTED. It requires per-prospect Interview/Conflicts/Affinities text data
//   that isn't present in ffl.db's rookies/draft_personal export — DraftAnalyzer's defaults are a
//   flat +/-Affinity(10)/Conflict(30) bonus/penalty when that text is non-empty, small relative to
//   the other terms, and we have no way to see it faithfully. Flagged, not silently faked.
//
// RatedPosition: a prospect is rated at his NATIVE position AND every cross-position alternate
// listed in ALTERNATE_POSITIONS below (identical to FOFData.PositionSizeRangesMap
// .AlternatePositions — e.g. every DE/DT/OLB/ILB/CB/S position is cross-rated against all 13
// others). Whichever scores highest becomes RatedPosition; that score's CombineScore/OverallScore
// become CombineSum/Rating. An alternate is only considered if its OverallScore > 0 (matches
// DraftAnalyzerForm.CalculatePlayerData exactly); the native position's score is always kept
// regardless of sign.
'use strict';

const GLOBAL = { attributesTotal: 100, combinesTotal: 10, noCombineCombinesTotal: 10, avgDev: 30, devWt: 10, thresholdPenalty: -100 };

const POSITION_TO_GROUP = {
  QB: 'QB', RB: 'RB', FB: 'FB', TE: 'TE', FL: 'WR', SE: 'WR',
  LT: 'T', RT: 'T', LG: 'G', RG: 'G', C: 'C',
  LDE: 'DE', RDE: 'DE', LDT: 'DT', RDT: 'DT', NT: 'DT',
  WILB: 'ILB', SILB: 'ILB', MLB: 'ILB', SLB: 'OLB', WLB: 'OLB',
  LCB: 'CB', RCB: 'CB', SS: 'S', FS: 'S', P: 'P', K: 'K', LS: 'LS',
};

// order: QB,RB,FB,WR,TE,T,G,C,DE,DT,ILB,OLB,CB,S,P,K,LS
const GROUP_ORDER = ['QB', 'RB', 'FB', 'WR', 'TE', 'T', 'G', 'C', 'DE', 'DT', 'ILB', 'OLB', 'CB', 'S', 'P', 'K', 'LS'];
const CHANNELS = ['dash', 'solecismic', 'bench', 'agility', 'broadJump', 'positionDrill'];

const AVG_ROWS = [
  [4.79, 28.0, 9.5, 7.87, 102.6, 71.2], [4.67, 20.7, 14.1, 7.35, 115.3, 17.4], [4.81, 21.9, 19.8, 7.58, 103.9, 23.4],
  [4.56, 21.0, 9.9, 7.26, 108.1, 40.3], [4.84, 23.3, 20.5, 7.95, 103.0, 28.0], [5.32, 27.3, 26.8, 7.91, 92.3, 0.0],
  [5.29, 28.0, 26.7, 8.02, 90.0, 0.0], [5.35, 29.6, 22.6, 8.12, 88.4, 0.0], [4.90, 23.6, 25.7, 7.68, 107.8, 0.0],
  [5.14, 22.4, 27.4, 7.92, 97.3, 0.0], [4.88, 27.1, 20.3, 7.68, 104.4, 23.4], [4.75, 25.1, 16.8, 7.46, 108.6, 23.6],
  [4.55, 22.2, 10.9, 7.26, 107.2, 35.0], [4.62, 28.8, 14.2, 7.42, 99.1, 35.0], [5.09, 25.6, 10.1, 7.69, 106.8, 0.0],
  [5.15, 27.0, 9.1, 7.67, 103.7, 0.0], [5.35, 29.6, 22.6, 8.12, 88.4, 0.0],
];
const STD_ROWS = [
  [0.151, 7.21, 2.19, 0.253, 6.01, 9.55], [0.093, 6.45, 3.44, 0.151, 5.14, 6.30], [0.078, 5.75, 3.90, 0.199, 5.07, 7.51],
  [0.104, 6.99, 3.09, 0.194, 4.92, 9.94], [0.097, 6.81, 4.22, 0.358, 6.69, 10.54], [0.166, 10.24, 5.07, 0.268, 6.66, 0.00],
  [0.135, 9.76, 4.27, 0.268, 6.32, 0.00], [0.133, 9.87, 4.82, 0.220, 6.69, 0.00], [0.140, 6.82, 3.93, 0.300, 7.34, 0.00],
  [0.143, 6.54, 3.71, 0.331, 9.43, 0.00], [0.111, 7.09, 3.53, 0.240, 5.93, 7.67], [0.119, 7.13, 3.49, 0.199, 5.86, 7.72],
  [0.079, 6.90, 2.56, 0.201, 4.35, 9.42], [0.091, 7.59, 2.97, 0.224, 4.31, 9.41], [0.179, 7.44, 3.62, 0.338, 7.04, 0.00],
  [0.136, 7.47, 2.87, 0.337, 6.40, 0.00], [0.133, 9.87, 4.82, 0.220, 6.69, 0.00],
];
// raw thresholds as stored (Dash and Agility get /100 applied below to become seconds)
const THRESHOLD_ROWS = [
  [0, 28, 10, 780, 0, 0], [465, 0, 0, 735, 114, 17], [478, 0, 20, 0, 104, 22], [451, 0, 0, 720, 0, 42],
  [478, 0, 22, 775, 102, 0], [527, 0, 28, 780, 84, 0], [527, 0, 27, 790, 0, 0], [531, 0, 25, 800, 0, 0],
  [485, 0, 27, 760, 0, 0], [0, 0, 28, 780, 0, 0], [0, 0, 21, 760, 107, 0], [0, 0, 18, 740, 108, 22],
  [452, 0, 12, 720, 0, 37], [459, 0, 15, 735, 0, 37], [497, 0, 10, 0, 0, 0], [0, 23, 9, 0, 104, 0],
  [531, 0, 25, 800, 0, 0],
];

const COMBINE_STATS = {};
GROUP_ORDER.forEach((g, i) => {
  const avg = {}, std = {}, threshold = {};
  CHANNELS.forEach((ch, j) => {
    avg[ch] = AVG_ROWS[i][j];
    std[ch] = STD_ROWS[i][j];
    threshold[ch] = (ch === 'dash' || ch === 'agility') ? THRESHOLD_ROWS[i][j] / 100.0 : THRESHOLD_ROWS[i][j];
  });
  // Dash and Agility: lower is better, so the stddev is negated (matches DraftAnalyzerForm.cs
  // InitializeCombineMap: "data.m40YardStdDev *= -1.0; data.mAgilityStdDev *= -1.0;").
  std.dash *= -1;
  std.agility *= -1;
  COMBINE_STATS[g] = { avg, std, threshold };
});

// Ideal average height, inches — only nonzero for positions where FOFData.PositionSizeRangesMap
// sets AverageHeight (everyone else has heightFactor=0 anyway, so this never gets used for them).
const IDEAL_HEIGHT = { QB: 74, TE: 76, FL: 72, SE: 72, NT: 75, LCB: 71, RCB: 71 };

// Full cross-position rating list per FOFData.PositionSizeRangesMap.AlternatePositions.
const ALTERNATE_POSITIONS = {
  QB: [], RB: [], FB: [], TE: [], FL: ['SE'], SE: ['FL'],
  LT: ['LG', 'C', 'RG', 'RT'], LG: ['C', 'RG'], C: [], RG: ['LG', 'C'], RT: ['LT', 'LG', 'C', 'RG'],
  P: [], K: [],
  LDE: ['LDT', 'NT', 'RDT', 'RDE', 'SLB', 'SILB', 'MLB', 'WILB', 'WLB', 'LCB', 'RCB', 'SS', 'FS'],
  LDT: ['LDE', 'NT', 'RDT', 'RDE', 'SLB', 'SILB', 'MLB', 'WILB', 'WLB', 'LCB', 'RCB', 'SS', 'FS'],
  NT: ['LDE', 'LDT', 'RDT', 'RDE', 'SLB', 'SILB', 'MLB', 'WILB', 'WLB', 'LCB', 'RCB', 'SS', 'FS'],
  RDT: ['LDE', 'LDT', 'NT', 'RDE', 'SLB', 'SILB', 'MLB', 'WILB', 'WLB', 'LCB', 'RCB', 'SS', 'FS'],
  RDE: ['LDE', 'LDT', 'NT', 'RDT', 'SLB', 'SILB', 'MLB', 'WILB', 'WLB', 'LCB', 'RCB', 'SS', 'FS'],
  SLB: ['LDE', 'LDT', 'NT', 'RDT', 'RDE', 'SILB', 'MLB', 'WILB', 'WLB', 'LCB', 'RCB', 'SS', 'FS'],
  SILB: ['LDE', 'LDT', 'NT', 'RDT', 'RDE', 'SLB', 'MLB', 'WILB', 'WLB', 'LCB', 'RCB', 'SS', 'FS'],
  MLB: ['LDE', 'LDT', 'NT', 'RDT', 'RDE', 'SLB', 'SILB', 'WILB', 'WLB', 'LCB', 'RCB', 'SS', 'FS'],
  WILB: ['LDE', 'LDT', 'NT', 'RDT', 'RDE', 'SLB', 'SILB', 'MLB', 'WLB', 'LCB', 'RCB', 'SS', 'FS'],
  WLB: ['LDE', 'LDT', 'NT', 'RDT', 'RDE', 'SLB', 'SILB', 'MLB', 'WILB', 'LCB', 'RCB', 'SS', 'FS'],
  LCB: ['LDE', 'LDT', 'NT', 'RDT', 'RDE', 'SLB', 'SILB', 'MLB', 'WILB', 'WLB', 'RCB', 'SS', 'FS'],
  RCB: ['LDE', 'LDT', 'NT', 'RDT', 'RDE', 'SLB', 'SILB', 'MLB', 'WILB', 'WLB', 'LCB', 'SS', 'FS'],
  SS: ['LDE', 'LDT', 'NT', 'RDT', 'RDE', 'SLB', 'SILB', 'MLB', 'WILB', 'WLB', 'LCB', 'RCB', 'FS'],
  FS: ['LDE', 'LDT', 'NT', 'RDT', 'RDE', 'SLB', 'SILB', 'MLB', 'WILB', 'WLB', 'LCB', 'RCB', 'SS'],
  LS: [],
};

// Per-position combine-drill weights (raw, pre-normalization) and overall multiplier/size
// factors — transcribed verbatim from DraftWeights.cs InitializeMap()'s default position blocks,
// confirmed byte-identical to the live DraftAnalyzer.weights file for every position checked.
// heightFactor/weightFactor are stored already halved (BuildWeightFromInput applies *0.5).
const POSITION_WEIGHTS = {
  QB: { weight: 1.137, combine: { dash: 0, solecismic: 20, bench: 10, agility: 10, broadJump: 15, positionDrill: 15 }, heightFactor: 1.0, weightFactor: 0.0,
    attrs: [['Screen_Passes', 20], ['Short_Passes', 19], ['Medium_Passes', 22], ['Long_Passes', 22], ['Deep_Passes', 15], ['Third_Down', 24], ['Accuracy', 23], ['Timing', 0], ['Sense_Rush', 8], ['Read_Defense', 11], ['Two-Minute_Offense', 7], ['Run_Frequency', 0], ['Kick_Holding', 0]] },
  RB: { weight: 1.058, combine: { dash: 5, solecismic: 20, bench: 5, agility: 8, broadJump: 10, positionDrill: 5 }, heightFactor: 0.0, weightFactor: 0.5,
    attrs: [['Speed', 5], ['Power_Inside', 5], ['Third-Down_Runs', 8], ['Hole_Recognition', 25], ['Elusiveness', 8], ['Speed_Outside', 5], ['Blitz_Pickup', 6], ['Avoid_Drops', 6], ['Get_Downfield', 2], ['Route_Running', 6], ['Third-Down_Receiving', 2], ['Punt_Returns', 1], ['Kick_Returns', 1], ['Endurance', 15], ['Special_Teams', 2]] },
  FB: { weight: 0.805, combine: { dash: 5, solecismic: 15, bench: 10, agility: 5, broadJump: 20, positionDrill: 15 }, heightFactor: 0.0, weightFactor: 0.5,
    attrs: [['Run_Blocking', 22], ['Pass_Blocking', 5], ['Blocking_Strength', 3], ['Power_Inside', 9], ['Third-Down_Runs', 7], ['Hole_Recognition', 14], ['Blitz_Pickup', 12], ['Avoid_Drops', 6], ['Route_Running', 8], ['Third-Down_Receiving', 3], ['Endurance', 5], ['Special_Teams', 2]] },
  TE: { weight: 0.867, combine: { dash: 10, solecismic: 15, bench: 10, agility: 10, broadJump: 20, positionDrill: 8 }, heightFactor: 1.0, weightFactor: 0.5,
    attrs: [['Run_Blocking', 24], ['Pass_Blocking', 20], ['Blocking_Strength', 15], ['Avoid_Drops', 12], ['Get_Downfield', 12], ['Route_Running', 25], ['Third-Down_Receiving', 18], ['Big_Play_Receiving', 3], ['Courage', 5], ['Adjust_to_Ball', 4], ['Endurance', 8], ['Special_Teams', 1], ['Long_Snapping', 0]] },
  FL: { weight: 1.036, combine: { dash: 15, solecismic: 20, bench: 5, agility: 18, broadJump: 2, positionDrill: 10 }, heightFactor: 1.0, weightFactor: 0.5,
    attrs: [['Avoid_Drops', 10], ['Get_Downfield', 16], ['Route_Running', 24], ['Third-Down_Receiving', 13], ['Big_Play_Receiving', 8], ['Courage', 6], ['Adjust_to_Ball', 5], ['Punt_Returns', 5], ['Kick_Returns', 5], ['Endurance', 4], ['Special_Teams', 1]] },
  SE: null, // filled below (identical to FL)
  C: { weight: 0.856, combine: { dash: 20, solecismic: 1, bench: 12, agility: 17, broadJump: 7, positionDrill: 0 }, heightFactor: 0.0, weightFactor: 0.5,
    attrs: [['Run_Blocking', 24], ['Pass_Blocking', 17], ['Blocking_Strength', 12], ['Endurance', 7], ['Long_Snapping', 0]] },
  RG: { weight: 0.945, combine: { dash: 20, solecismic: 1, bench: 13, agility: 15, broadJump: 7, positionDrill: 0 }, heightFactor: 0.0, weightFactor: 0.5,
    attrs: [['Run_Blocking', 24], ['Pass_Blocking', 15], ['Blocking_Strength', 13], ['Endurance', 7]] },
  LG: null, // identical to RG
  RT: { weight: 1.095, combine: { dash: 20, solecismic: 1, bench: 10, agility: 20, broadJump: 7, positionDrill: 0 }, heightFactor: 0.0, weightFactor: 0.5,
    attrs: [['Run_Blocking', 24], ['Pass_Blocking', 23], ['Blocking_Strength', 13], ['Endurance', 8]] },
  LT: null, // identical to RT
  P: { weight: 0.529, combine: { dash: 20, solecismic: 10, bench: 15, agility: 0, broadJump: 0, positionDrill: 0 }, heightFactor: 0.0, weightFactor: 0.0,
    attrs: [['Punting_Power', 25], ['Hang_Time', 12], ['Directional_Punting', 8], ['Kick_Holding', 0]] },
  K: { weight: 0.591, combine: { dash: 5, solecismic: 20, bench: 15, agility: 0, broadJump: 7, positionDrill: 10 }, heightFactor: 0.0, weightFactor: 0.0,
    attrs: [['Kicking_Accuracy', 25], ['Kicking_Power', 14], ['Kickoff_Distance', 3], ['Kickoff_Hang_Time', 2]] },
  LDE: { weight: 1.095, combine: { dash: 17, solecismic: 5, bench: 15, agility: 20, broadJump: 5, positionDrill: 0 }, heightFactor: 0.0, weightFactor: 1.0,
    attrs: [['Run_Defense', 25], ['Pass_Rush_Technique', 18], ['Man-to-Man_Defense', 0], ['Zone_Defense', 0], ['Bump-and-Run_Defense', 0], ['Pass_Rush_Strength', 16], ['Play_Diagnosis', 6], ['Punishing_Hitter', 3], ['Endurance', 6], ['Special_Teams', 0]] },
  RDE: null, // identical to LDE
  LDT: { weight: 1.076, combine: { dash: 10, solecismic: 5, bench: 10, agility: 20, broadJump: 5, positionDrill: 0 }, heightFactor: 0.0, weightFactor: 1.0,
    attrs: [['Run_Defense', 25], ['Pass_Rush_Technique', 10], ['Man-to-Man_Defense', 0], ['Zone_Defense', 0], ['Bump-and-Run_Defense', 0], ['Pass_Rush_Strength', 13], ['Play_Diagnosis', 4], ['Punishing_Hitter', 2], ['Endurance', 6], ['Special_Teams', 0]] },
  RDT: null, // identical to LDT
  NT: { weight: 1.076, combine: { dash: 10, solecismic: 5, bench: 10, agility: 20, broadJump: 5, positionDrill: 0 }, heightFactor: 0.5, weightFactor: 1.0,
    attrs: [['Run_Defense', 25], ['Pass_Rush_Technique', 10], ['Man-to-Man_Defense', 0], ['Zone_Defense', 0], ['Bump-and-Run_Defense', 0], ['Pass_Rush_Strength', 13], ['Play_Diagnosis', 4], ['Punishing_Hitter', 2], ['Endurance', 6], ['Special_Teams', 0]] },
  WILB: { weight: 0.971, combine: { dash: 5, solecismic: 10, bench: 10, agility: 20, broadJump: 10, positionDrill: 10 }, heightFactor: 0.0, weightFactor: 1.0,
    attrs: [['Run_Defense', 25], ['Pass_Rush_Technique', 5], ['Man-to-Man_Defense', 8], ['Zone_Defense', 8], ['Bump-and-Run_Defense', 8], ['Pass_Rush_Strength', 2], ['Play_Diagnosis', 8], ['Punishing_Hitter', 4], ['Endurance', 4], ['Special_Teams', 1]] },
  SILB: null, // identical to WILB
  MLB: null, // identical to WILB
  SLB: { weight: 0.955, combine: { dash: 5, solecismic: 8, bench: 12, agility: 20, broadJump: 12, positionDrill: 10 }, heightFactor: 0.0, weightFactor: 1.0,
    attrs: [['Run_Defense', 25], ['Pass_Rush_Technique', 8], ['Man-to-Man_Defense', 10], ['Zone_Defense', 10], ['Bump-and-Run_Defense', 10], ['Pass_Rush_Strength', 2], ['Play_Diagnosis', 8], ['Punishing_Hitter', 4], ['Endurance', 4], ['Special_Teams', 1]] },
  WLB: null, // identical to SLB
  LCB: { weight: 1.027, combine: { dash: 20, solecismic: 10, bench: 10, agility: 15, broadJump: 1, positionDrill: 20 }, heightFactor: 0.5, weightFactor: 0.5,
    attrs: [['Run_Defense', 16], ['Man-to-Man_Defense', 24], ['Zone_Defense', 22], ['Bump-and-Run_Defense', 24], ['Play_Diagnosis', 8], ['Punishing_Hitter', 2], ['Intercepting', 9], ['Punt_Returns', 1], ['Kick_Returns', 1], ['Endurance', 5], ['Special_Teams', 1]] },
  RCB: null, // identical to LCB
  SS: { weight: 0.938, combine: { dash: 10, solecismic: 7, bench: 10, agility: 20, broadJump: 1, positionDrill: 10 }, heightFactor: 0.0, weightFactor: 1.0,
    attrs: [['Run_Defense', 25], ['Man-to-Man_Defense', 11], ['Zone_Defense', 11], ['Bump-and-Run_Defense', 11], ['Play_Diagnosis', 9], ['Punishing_Hitter', 3], ['Intercepting', 7], ['Punt_Returns', 1], ['Kick_Returns', 1], ['Endurance', 4], ['Special_Teams', 1]] },
  FS: null, // identical to SS
  LS: { weight: 0.86, combine: { dash: 10, solecismic: 10, bench: 10, agility: 10, broadJump: 10, positionDrill: 0 }, heightFactor: 0.0, weightFactor: 0.0,
    attrs: [['Long_Snapping', 25]] },
};
POSITION_WEIGHTS.SE = POSITION_WEIGHTS.FL;
POSITION_WEIGHTS.LG = POSITION_WEIGHTS.RG;
POSITION_WEIGHTS.LT = POSITION_WEIGHTS.RT;
POSITION_WEIGHTS.RDE = POSITION_WEIGHTS.LDE;
POSITION_WEIGHTS.RDT = POSITION_WEIGHTS.LDT;
POSITION_WEIGHTS.SILB = POSITION_WEIGHTS.WILB;
POSITION_WEIGHTS.MLB = POSITION_WEIGHTS.WILB;
POSITION_WEIGHTS.WLB = POSITION_WEIGHTS.SLB;
POSITION_WEIGHTS.RCB = POSITION_WEIGHTS.LCB;
POSITION_WEIGHTS.FS = POSITION_WEIGHTS.SS;

function normalize(weights, target) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum <= 0) return Object.fromEntries(Object.keys(weights).map(k => [k, 0]));
  const factor = target / sum;
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, v * factor]));
}
function normalizeAttrs(attrs, target) {
  const sum = attrs.reduce((s, [, w]) => s + w, 0);
  if (sum <= 0) return attrs.map(([name]) => [name, 0]);
  const factor = target / sum;
  return attrs.map(([name, w]) => [name, w * factor]);
}

// Pre-normalize every position's weight sets once at module load.
const NORMALIZED = {};
for (const [pos, pw] of Object.entries(POSITION_WEIGHTS)) {
  NORMALIZED[pos] = {
    combineFull: normalize(pw.combine, GLOBAL.combinesTotal),
    combineNoTest: normalize({ solecismic: pw.combine.solecismic, positionDrill: pw.combine.positionDrill }, GLOBAL.noCombineCombinesTotal),
    attrs: normalizeAttrs(pw.attrs, GLOBAL.attributesTotal),
  };
}

function combineScore(prospect, testPosition) {
  const stats = COMBINE_STATS[POSITION_TO_GROUP[prospect.nativePosition]];
  const hasCombine = prospect.solecismic !== 0 && prospect.dash !== 0 && prospect.bench !== 0 && prospect.agility !== 0 && prospect.broadJump !== 0;
  const w = hasCombine ? NORMALIZED[testPosition].combineFull : NORMALIZED[testPosition].combineNoTest;

  function channel(name, rawValue, badIfAbove) {
    if (!hasCombine && name !== 'solecismic' && name !== 'positionDrill') return 0;
    if (stats.std[name] === 0) return 0; // group has no valid data for this drill at all
    if (!hasCombine && rawValue === 0) return 0; // no-combine branch still requires the value itself present
    const threshold = stats.threshold[name];
    if (GLOBAL.thresholdPenalty !== 0 && threshold > 0) {
      const crossed = badIfAbove ? rawValue > threshold : rawValue < threshold;
      if (crossed) return GLOBAL.thresholdPenalty;
    }
    return ((rawValue - stats.avg[name]) / stats.std[name]) * w[name];
  }

  return channel('dash', prospect.dash, true) +
    channel('solecismic', prospect.solecismic, false) +
    channel('bench', prospect.bench, false) +
    channel('agility', prospect.agility, true) +
    channel('broadJump', prospect.broadJump, false) +
    channel('positionDrill', prospect.positionDrill, false);
}

function sizeScore(prospect, testPosition, idealWeightLookup) {
  const pw = POSITION_WEIGHTS[testPosition];
  const avgHeight = IDEAL_HEIGHT[testPosition] || 0;
  const heightDiff = avgHeight !== 0 ? prospect.height - avgHeight : 0;
  const weightDiff = idealWeightLookup(testPosition, prospect.weight);
  return heightDiff * pw.heightFactor - Math.abs(weightDiff) * pw.weightFactor;
}

function attributeScore(attrLowHigh, testPosition) {
  let total = 0;
  for (const [col, w] of NORMALIZED[testPosition].attrs) {
    const lo = attrLowHigh[`Low_${col}`] || 0;
    const hi = attrLowHigh[`High_${col}`] || 0;
    total += (lo + hi) * w * 0.005;
  }
  return total;
}

function developmentScore(developedPct) {
  return (developedPct - GLOBAL.avgDev) * (GLOBAL.devWt / GLOBAL.avgDev);
}

function rateAtPosition(prospect, attrLowHigh, testPosition, idealWeightLookup) {
  const combine = combineScore(prospect, testPosition);
  const size = sizeScore(prospect, testPosition, idealWeightLookup);
  const attribute = attributeScore(attrLowHigh, testPosition);
  const development = developmentScore(prospect.developed);
  const overall = (combine + size + attribute + development) * POSITION_WEIGHTS[testPosition].weight;
  return { position: testPosition, combineScore: combine, sizeScore: size, attributeScore: attribute, developmentScore: development, overallScore: overall };
}

// prospect: {nativePosition, height, weight, solecismic, dash (seconds), bench, agility (seconds),
//   broadJump, positionDrill, developed}. attrLowHigh: flat object of every Low_X/High_X column
// from draft_personal. idealWeightLookup(position, weight) => signed weightDiff (500 sentinel for
// the "no ideal weight defined under this scheme" gap, matching FOFData.GetWeightDifference).
function bestRating(prospect, attrLowHigh, idealWeightLookup) {
  const nativeRating = rateAtPosition(prospect, attrLowHigh, prospect.nativePosition, idealWeightLookup);
  let best = nativeRating;
  const ratings = [nativeRating];
  for (const alt of ALTERNATE_POSITIONS[prospect.nativePosition] || []) {
    const r = rateAtPosition(prospect, attrLowHigh, alt, idealWeightLookup);
    if (r.overallScore > 0) {
      ratings.push(r);
      if (r.overallScore > best.overallScore) best = r;
    }
  }
  return { ratedPosition: best.position, combineSum: best.combineScore, rating: best.overallScore, breakdown: best, allRatings: ratings, untested: !(prospect.solecismic !== 0 && prospect.dash !== 0 && prospect.bench !== 0 && prospect.agility !== 0 && prospect.broadJump !== 0) };
}

module.exports = { bestRating, rateAtPosition, POSITION_TO_GROUP, POSITION_WEIGHTS, ALTERNATE_POSITIONS, GROUP_ORDER, COMBINE_STATS };
