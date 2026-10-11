// Explosiveness Profile — v3. Size-adjusted explosiveness, per explicit user instruction
// (2026-08-18): blend ONLY Forty (Dash), Broad Jump, and Playing Weight, measured against the
// prospect's position group — NOT Bench Press. This replaces the v2 "absolute community
// calibration" design (Broad Jump + Bench Press, FOF8-community-sourced tier table), which is
// still valid research but is a different metric ("upper+lower body power") from what's wanted
// here ("how explosive is this athlete's get-off, relative to his own position group, adjusted
// for the mass he's carrying").
//
// Method: z-score each of Dash, Broad Jump, and Weight against the prospect's NATIVE position
// group, average the three z-scores, then convert to a 0-100 composite via the normal-distribution
// CDF (a smooth, theoretical "how many standard deviations above the mean" percentile — distinct
// from the empirical rank-based percentile also returned, which reflects only THIS live class).
// Dash and Broad Jump reuse draftAnalyzer.js's own COMBINE_STATS averages/std-devs (the same fixed
// historical baselines DraftAnalyzer's CombineScore is built on — dash's std-dev is already
// negated there so a faster time always produces a positive z, consistent here). Weight has no
// such baseline in DraftAnalyzer's own data (it isn't one of the 6 drills the tool tracks), so its
// average/std-dev is computed live from the current draft class's own position-group distribution.
'use strict';

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCdf(z) { return 0.5 * (1 + erf(z / Math.sqrt(2))); }

function tier(score) {
  if (score >= 90) return 'Elite';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Average';
  if (score >= 30) return 'Below Average';
  return 'Poor';
}

// prospects: array of { playerId, positionGroup, dash (seconds), broadJump (inches), weight (lbs) }.
// combineStats: draftAnalyzer.COMBINE_STATS (per-group avg/std for dash & broadJump).
// Returns Map<playerId, result | null>. null only when dash or broadJump isn't on file (untested).
function computeExplosiveness(prospects, combineStats) {
  const result = new Map();
  const byGroup = new Map();
  for (const p of prospects) {
    if (!byGroup.has(p.positionGroup)) byGroup.set(p.positionGroup, []);
    byGroup.get(p.positionGroup).push(p);
  }

  for (const [group, members] of byGroup) {
    const stats = combineStats[group];

    // Weight: live per-group average/std-dev from this class (no historical baseline exists).
    const weights = members.map(m => m.weight);
    const wAvg = weights.reduce((a, b) => a + b, 0) / weights.length;
    const wStd = Math.sqrt(weights.reduce((a, b) => a + (b - wAvg) ** 2, 0) / weights.length) || 1;

    const scored = members.map(p => {
      const hasDash = p.dash > 0;
      const hasJump = p.broadJump > 0;
      if (!hasDash || !hasJump || !stats) return { p, score: null };

      const zDash = stats.std.dash ? (p.dash - stats.avg.dash) / stats.std.dash : 0;
      const zJump = stats.std.broadJump ? (p.broadJump - stats.avg.broadJump) / stats.std.broadJump : 0;
      const zWeight = (p.weight - wAvg) / wStd;
      const zAvg = (zDash + zJump + zWeight) / 3;
      const score = normalCdf(zAvg) * 100;
      return {
        p, score, zDash, zJump, zWeight,
        dashScore: normalCdf(zDash) * 100,
        broadJumpScore: normalCdf(zJump) * 100,
        weightScore: normalCdf(zWeight) * 100,
      };
    });

    const tested = scored.filter(s => s.score != null);
    for (const s of scored) if (s.score == null) result.set(s.p.playerId, null);

    tested.sort((a, b) => b.score - a.score);
    const n = tested.length;
    tested.forEach((s, i) => {
      const rank = i + 1;
      result.set(s.p.playerId, {
        score: s.score,
        tier: tier(s.score),
        dashZ: s.zDash,
        broadJumpZ: s.zJump,
        weightZ: s.zWeight,
        dashScore: s.dashScore,
        broadJumpScore: s.broadJumpScore,
        weightScore: s.weightScore,
        positionRank: rank,
        groupSize: n,
        // Empirical rank-based percentile within THIS live class's position group (rank 1 = 100th
        // percentile) — deliberately shown alongside, not instead of, the CDF-based composite
        // score above: a high percentile in a weak class and a middling composite can both be
        // true at once, and that distinction is the point of showing both.
        percentile: n > 1 ? (100 * (n - rank) / (n - 1)) : 100,
      });
    });
  }
  return result;
}

module.exports = { computeExplosiveness, normalCdf, tier };
