// Board-assembly layer for the Draft Board app. This computes StelmackSoft DraftAnalyzer's own
// Rating/CombineSum/RatedPosition for every prospect in the current draft class, using
// lib/draftAnalyzer.js as the single source of truth for the formula (see that file's header for
// the full derivation and source references). This file's job is ONLY to pull each prospect's raw
// numbers out of ffl.db and hand them to draftAnalyzer.bestRating() — no scoring logic lives here.
//
// DefensiveFront is fixed to 4-3 Over (Pittsburgh's actual scheme, per the FFL README —
// overriding the True-34 value saved in DraftAnalyzer.weights, which
// only reflects whatever the tool's UI last had selected, not necessarily the live scheme) for
// the ideal-weight lookup.
//
// Tabs are grouped by each prospect's NATIVE position (same as DraftOrder.csv's "PositionGroup"
// column) — RatedPosition (shown as its own column) can differ, sometimes drastically, since
// DraftAnalyzer cross-rates every DE/DT/OLB/ILB/CB/S prospect against all 13 of those positions
// and keeps whichever scores highest.
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const draftAnalyzer = require('./draftAnalyzer.js');
const { computeExplosiveness } = require('./explosiveness.js');

const FFL_ROOT = path.join(__dirname, '..', '..');
const db = new DatabaseSync(path.join(FFL_ROOT, 'ffl.db'));

// QB Avoid_Interception estimate (Low/Expected/High) reuses ../../scripts/qb_card_model.js's own
// computeCard() verbatim — the same hidden-formula work behind this project's veteran QB cards
// (Draft_Methodology.md's "Avoid_Interception (AI)" section) — rather than re-deriving it here.
// That script opens its own separate DatabaseSync connection to the same ffl.db file at require
// time (harmless, sqlite supports concurrent readers) and only exports computeCard/computeVeteranCard;
// its CLI console.log block is guarded behind `require.main === module` so requiring it is silent.
const qbCardModel = require(path.join(FFL_ROOT, 'scripts', 'qb_card_model.js'));

// ---------------------------------------------------------------------------------------------
// Ideal weight lookup — mirrors FOFData.GetWeightDifference(position, weight, formation) exactly:
// offensive positions use their single Offense ideal; defensive positions use the ACTIVE_SCHEME
// column if set, else fall back to a flat 500 "no data for this scheme" penalty if any OTHER
// scheme column is set (this is a real, intentional quirk of the tool — see draftAnalyzer.js
// header). Under 4-3 Over specifically, NT/SILB/WILB hit that gap (a 4-3 front has no true nose
// tackle or true inside-backer slot) — LDT/RDT/MLB do NOT, unlike under True-34.
// ---------------------------------------------------------------------------------------------
const ACTIVE_SCHEME = 'Over_43';
const idealRows = db.prepare(`SELECT Position_Code, Offense, True_34, Eagle_34, Under_43, Over_43 FROM ideal_weights_by_scheme`).all();
const IDEAL_WEIGHTS = Object.fromEntries(idealRows.map(r => [r.Position_Code, r]));
function idealWeightDiff(position, weight) {
  const row = IDEAL_WEIGHTS[position];
  if (!row) return 0;
  if (row.Offense != null) return weight - row.Offense;
  if (row[ACTIVE_SCHEME] != null) return weight - row[ACTIVE_SCHEME];
  if (row.True_34 != null || row.Eagle_34 != null || row.Under_43 != null || row.Over_43 != null) return 500;
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Load every prospect once: identity + combine numbers + native position + full draft_personal
// row (every Low_X/High_X column, used generically by attributeScore() regardless of which
// candidate position is being tested).
// ---------------------------------------------------------------------------------------------
const rows = db.prepare(`
  SELECT r.Player_ID, r.First_Name, r.Last_Name, r.College, r.Position_Group,
         r.Height, r.Weight, r.Solecismic, r.Dash, r.Strength, r.Agility, r.Jump,
         r.Position_Specific, r.Developed, r.Grade,
         p.Position AS NativePosition, p.Month_Born, p.Day_Born, p.Year_Born,
         pr.Volatility AS Volatility,
         dp.*
  FROM rookies r
  JOIN player_information p ON p.Player_ID = r.Player_ID
  LEFT JOIN player_record pr ON pr.Player_ID = r.Player_ID
  JOIN draft_personal dp ON dp.Player_ID = r.Player_ID
`).all();

// ---------------------------------------------------------------------------------------------
// Prospect Bars — the position's own AttributeScore sub-ratings (POSITION_WEIGHTS[pos].attrs),
// shown as Low-to-High scouted ranges ("Current" -> "Future"). This is the exact same attribute
// list draftAnalyzer.attributeScore() already sums over for that position, just surfaced
// individually instead of collapsed into one AttributeScore number.
//
// One attribute per position is drawn as a "spotlight" bar in an accent color rather than the
// standard range bar: the position's single highest-weighted attribute, EXCEPT QB, which is
// hardcoded to Sense_Rush — not QB's highest-weighted attribute (Third_Down is), but the one
// scouted input that feeds the hidden Avoid_Interception term in this project's own veteran QB
// model (../../scripts/qb_card_model.js), which is why it's worth calling out here specifically.
// ---------------------------------------------------------------------------------------------
const SPOTLIGHT_OVERRIDE = { QB: 'Sense_Rush' };
function spotlightAttr(position) {
  if (SPOTLIGHT_OVERRIDE[position]) return SPOTLIGHT_OVERRIDE[position];
  const attrs = draftAnalyzer.POSITION_WEIGHTS[position]?.attrs || [];
  if (!attrs.length) return null;
  return attrs.reduce((best, cur) => (cur[1] > best[1] ? cur : best), attrs[0])[0];
}
function buildAttrBars(nativePosition, r) {
  const attrs = draftAnalyzer.POSITION_WEIGHTS[nativePosition]?.attrs || [];
  const spotlight = spotlightAttr(nativePosition);
  return attrs
    .map(([col, weight]) => {
      const lo = r[`Low_${col}`];
      const hi = r[`High_${col}`];
      return {
        key: col,
        label: col.replace(/_/g, ' '),
        low: lo == null ? null : Number(lo),
        high: hi == null ? null : Number(hi),
        weight,
        spotlight: col === spotlight,
      };
    })
    .filter(b => b.low != null && b.high != null);
}

// Combine-drill tiering vs draftAnalyzer's own fixed historical per-position-group baselines
// (COMBINE_STATS — the same avg/stddev table combineScore() uses, sign-adjusted so higher-z is
// always better even for dash/agility). Purely a display summary, not fed back into any score.
function combineHighlights(nativePosition, combine, dash) {
  const group = draftAnalyzer.POSITION_TO_GROUP[nativePosition];
  const stats = draftAnalyzer.COMBINE_STATS[group];
  if (!stats) return { elite: 0, superior: 0, great: 0 };
  const channels = [
    ['dash', dash / 100], ['solecismic', combine.solecismic], ['bench', combine.bench],
    ['agility', combine.agility / 100], ['broadJump', combine.broadJump], ['positionDrill', combine.positionDrill],
  ];
  let elite = 0, superior = 0, great = 0;
  for (const [ch, val] of channels) {
    if (!val || stats.std[ch] === 0) continue;
    const z = (val - stats.avg[ch]) / stats.std[ch];
    if (z >= 2) elite++;
    else if (z >= 1.5) superior++;
    else if (z >= 1) great++;
  }
  return { elite, superior, great };
}

// Per-drill color tier for the Prospect Fingerprint's measurables row (2026-08-18 request) — a
// 5-band read of EACH combine drill (Dash, Solecismic, Bench, Agility, Broad Jump) against the
// prospect's own native position group, using the exact same z-score baseline as
// combineHighlights()/combineScore() above. Band cutoffs are an original design choice (not
// sourced from the community research cited elsewhere in this file), chosen as a standard
// bell-curve-ish split: Poor bottom ~23%, Average next ~27%, Good next ~27%, Great next ~16%,
// Elite top ~7%. This is purely a display tier — it doesn't feed into Rating, CombineSum, or
// Explosiveness.
function combineTier(z) {
  if (z >= 1.5) return 'elite';
  if (z >= 0.75) return 'great';
  if (z >= 0) return 'good';
  if (z >= -0.75) return 'average';
  return 'poor';
}
function combineTiers(nativePosition, combine, dash) {
  const group = draftAnalyzer.POSITION_TO_GROUP[nativePosition];
  const stats = draftAnalyzer.COMBINE_STATS[group];
  const channels = {
    dash: dash / 100, solecismic: combine.solecismic, bench: combine.bench,
    agility: combine.agility / 100, broadJump: combine.broadJump,
  };
  const tiers = {};
  for (const [ch, val] of Object.entries(channels)) {
    if (!stats || !val || stats.std[ch] === 0) { tiers[ch] = null; continue; }
    tiers[ch] = combineTier((val - stats.avg[ch]) / stats.std[ch]);
  }
  return tiers;
}

// "Elite physical profile" thresholds — from FOF8-community research (Gemini chat, 2026-08-15,
// https://share.gemini.google/Ub2XQnSPAkOo, citing www.solecismic.com), a DIFFERENT concept from
// the Explosiveness score above: a flat pass/fail bar per drill used to flag outlier athletes,
// not a blended rating. Only covers the position groups that source gave numbers for. Dash and
// Broad Jump map directly to this dataset's own fields; the source's "3-Cone" column is applied
// to this dataset's Agility drill — per that same research's own drill-to-rating mapping table,
// Agility IS the internal rating 3-Cone (and 20-yard Shuttle) drive, not merely an approximation
// of it, so no hedging needed (confirmed 2026-08-18). Thresholds stored in this dataset's raw
// units (dash/agility as hundredths of a second, e.g. 442 = 4.42s; broadJump in inches).
//
// Bench added 2026-08-18, from a DIFFERENT part of the same research thread (the Explosiveness
// tier table's "90-100 Elite" row: "30+ reps") — that source gives ONE flat rep count, not a
// position-scaled table like Dash/Broad Jump/Agility above, so it's applied uniformly here across
// every covered position rather than varying by group.
//
// Solecismic has NO community-sourced elite threshold in either Gemini thread cited in this
// project (checked both in full 2026-08-18) — not added pending a real source or an explicit
// number from the user, rather than guessing one.
const BENCH_ELITE_REPS = 30;
const PHYSICAL_THRESHOLDS = {
  CB: { dash: 442, broadJump: 124, agility: 675 },
  WR: { dash: 442, broadJump: 124, agility: 675 },
  RB: { dash: 448, broadJump: 122, agility: 685 },
  DE: { dash: 465, broadJump: 118, agility: 705 },
  OLB: { dash: 465, broadJump: 118, agility: 705 },
  ILB: { dash: 465, broadJump: 118, agility: 705 },
  T: { dash: 505, broadJump: 108, agility: 750 },
  G: { dash: 505, broadJump: 108, agility: 750 },
  C: { dash: 505, broadJump: 108, agility: 750 },
  DT: { dash: 505, broadJump: 108, agility: 750 },
};
function physicalProfile(nativePosition, dash, agility, broadJump, bench) {
  const group = draftAnalyzer.POSITION_TO_GROUP[nativePosition];
  const t = PHYSICAL_THRESHOLDS[group];
  if (!t) return { applicable: false };
  if (!(dash > 0 && agility > 0 && broadJump > 0 && bench > 0)) return { applicable: false };
  const clears = {
    dash: dash < t.dash,
    broadJump: broadJump >= t.broadJump,
    agility: agility < t.agility,
    bench: bench >= BENCH_ELITE_REPS,
  };
  const count = Object.values(clears).filter(Boolean).length;
  return { applicable: true, clears, count, total: 4, thresholds: { ...t, bench: BENCH_ELITE_REPS } };
}

// QB-only: Expected Avoid_Interception (Low/Expected/High), straight from qb_card_model.js's
// computeCard(). Untested prospects (Dash=0) still get a real estimate — computeCard's midpoint
// fallback doesn't depend on the combine-blended Accuracy/Deep/Long models needing Dash — so this
// isn't gated on the same untested flag as the rest of the combine data.
function qbAvoidInterception(nativePosition, playerId) {
  if (nativePosition !== 'QB') return null;
  try {
    const card = qbCardModel.computeCard(playerId);
    const ai = card.attributes.Avoid_Interception;
    return { low: ai.lo, expected: ai.expected, high: ai.hi };
  } catch (e) {
    return null;
  }
}

const PROSPECTS = rows.map(r => {
  const prospect = {
    nativePosition: r.NativePosition,
    height: r.Height,
    weight: r.Weight,
    solecismic: r.Solecismic,
    dash: r.Dash / 100,
    bench: r.Strength,
    agility: r.Agility / 100,
    broadJump: r.Jump,
    positionDrill: r.Position_Specific,
    developed: r.Developed,
  };
  const rating = draftAnalyzer.bestRating(prospect, r, (pos, wt) => idealWeightDiff(pos, wt));
  return {
    playerId: r.Player_ID,
    player: `${r.First_Name} ${r.Last_Name}`,
    college: r.College,
    positionGroup: r.Position_Group,
    nativePosition: r.NativePosition,
    height: r.Height,
    weight: r.Weight,
    dash: r.Dash,
    grade: r.Grade,
    developed: r.Developed,
    volatility: r.Volatility,
    combine: { solecismic: r.Solecismic, bench: r.Strength, agility: r.Agility, broadJump: r.Jump, positionDrill: r.Position_Specific },
    attrBars: buildAttrBars(r.NativePosition, r),
    combineHighlights: combineHighlights(r.NativePosition, { solecismic: r.Solecismic, bench: r.Strength, agility: r.Agility, broadJump: r.Jump, positionDrill: r.Position_Specific }, r.Dash),
    combineTiers: combineTiers(r.NativePosition, { solecismic: r.Solecismic, bench: r.Strength, agility: r.Agility, broadJump: r.Jump }, r.Dash),
    physicalProfile: physicalProfile(r.NativePosition, r.Dash, r.Agility, r.Jump, r.Strength),
    avoidInterception: qbAvoidInterception(r.NativePosition, r.Player_ID),
    untested: rating.untested,
    ratedPosition: rating.ratedPosition,
    combineSum: rating.combineSum,
    rating: rating.rating,
    breakdown: rating.breakdown,
    allRatings: rating.allRatings.map(r => ({ position: r.position, combineScore: r.combineScore, sizeScore: r.sizeScore, attributeScore: r.attributeScore, developmentScore: r.developmentScore, overallScore: r.overallScore })).sort((a, b) => b.overallScore - a.overallScore),
    identityKey: `${r.First_Name}|${r.Last_Name}|${r.Month_Born}-${r.Day_Born}-${r.Year_Born}`,
    birthDate: `${r.Month_Born}-${r.Day_Born}-${r.Year_Born}`,
  };
});

// Explosiveness is grouped by positionGroup (draftAnalyzer's native-position granularity, e.g.
// LDE/RDE both roll into the DE group via POSITION_TO_GROUP) so a prospect is only ever compared
// against others tested at the same drills/expectations.
const explosivenessMap = computeExplosiveness(
  PROSPECTS.map(p => ({
    playerId: p.playerId,
    positionGroup: draftAnalyzer.POSITION_TO_GROUP[p.nativePosition],
    dash: p.dash / 100,
    broadJump: p.combine.broadJump,
    weight: p.weight,
  })),
  draftAnalyzer.COMBINE_STATS
);
for (const p of PROSPECTS) p.explosiveness = explosivenessMap.get(p.playerId) || null;

// ---------------------------------------------------------------------------------------------
// Tabs, grouped by native Position_Group (same grouping DraftOrder.csv itself uses) — except
// EDGE/DT, which are split by WEIGHT instead of raw position, per user instruction (2026-08-16):
// a 4-3 DE-listed prospect (or a stout SLB/WLB) in the 255-280lb range projects as a true edge
// rusher; anyone at RDE/LDE/LDT/RDT/NT heavier than 280lb projects inside as an interior lineman,
// regardless of what he's natively listed as. A board can define EITHER `groups` (native
// Position_Group membership) OR `filter` (a custom predicate over the full prospect object) —
// not both.
//
// Known gap, inherent to the thresholds as given, not a bug: a DE-listed prospect under 255lb, or
// a DT/NT-listed prospect at or under 280lb, satisfies neither filter and won't appear on EITHER
// board — only on Linebacker (if native WLB/SLB) or not at all otherwise.
// ---------------------------------------------------------------------------------------------
const EDGE_NATIVE_POSITIONS = ['LDE', 'RDE', 'WLB', 'SLB'];
const INTERIOR_NATIVE_POSITIONS = ['LDE', 'RDE', 'LDT', 'RDT', 'NT'];

const BOARDS = {
  QB: { label: 'Quarterback', family: 'Offense', groups: ['QB'] },
  RB: { label: 'Running Back', family: 'Offense', groups: ['RB'] },
  FB: { label: 'Fullback', family: 'Offense', groups: ['FB'] },
  WR: { label: 'Wide Receiver', family: 'Offense', groups: ['WR'] },
  TE: { label: 'Tight End', family: 'Offense', groups: ['TE'] },
  OL: { label: 'Offensive Line', family: 'Offense', groups: ['T', 'G', 'C'] },
  EDGE: { label: 'Edge Rusher', family: 'Defense', filter: p => EDGE_NATIVE_POSITIONS.includes(p.nativePosition) && p.weight >= 255 && p.weight <= 280 },
  DT: { label: 'Interior D-Line', family: 'Defense', filter: p => INTERIOR_NATIVE_POSITIONS.includes(p.nativePosition) && p.weight > 280 },
  LB: { label: 'Linebacker', family: 'Defense', groups: ['OLB', 'ILB'] },
  CB: { label: 'Cornerback', family: 'Defense', groups: ['CB'] },
  S: { label: 'Safety', family: 'Defense', groups: ['S'] },
  ST: { label: 'Specialists', family: 'Special Teams', groups: ['K', 'P', 'LS'] },
};

function listGroups() {
  const groups = Object.entries(BOARDS).map(([key, b]) => ({ key, label: b.label, family: b.family, hasModel: true, modelNote: null }));
  groups.unshift({ key: 'PRIORITY', label: 'Priority Draft List', family: 'Tools', hasModel: true, modelNote: null });
  return groups;
}

function getBoard(key) {
  const b = BOARDS[key];
  if (!b) throw new Error(`Unknown board key: ${key}`);
  const board = PROSPECTS.filter(b.filter || (p => b.groups.includes(p.positionGroup)));
  board.sort((a, b2) => b2.rating - a.rating);
  return board;
}

function getAllProspects() {
  return PROSPECTS;
}

module.exports = { listGroups, getBoard, getAllProspects };
