// AGING / DEVELOPMENT CURVES BY POSITION.
//
// Extends the QB rookie-vs-veteran finding (ratings don't convert to production until ~5 years
// in) to every position we've already built a stats pipeline for. For each position, buckets
// every historical season (Position filter, Current_Overall > 0, i.e. Year>=2039 real-ratings
// window per cfl_database_overview memory) by Experience = Year - Draft_Year (excludes
// Draft_Year=0 undrafted rows, same convention as the QB analysis), then reports the average
// key rating(s) AND average key stat(s) at each experience level, 0 through 11 (12+ grouped
// into one tail bucket to avoid tiny-n noise at the far end of careers).
//
// Purpose: for evaluating a free agent, you need to know not just "is his rating good" but
// "is he in his prime window for that rating to show up in production, or is he past it /
// not there yet." This is exactly the gap the QB analysis found — the same check needs to run
// per position before trusting any ratings-based free agent projection.
// Usage: node scripts/position_aging_curves.js
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'ffl.db'));

const MAX_EXP_BUCKET = 11; // experience 12+ gets grouped into one tail bucket

function bucketExp(exp) { return exp > MAX_EXP_BUCKET ? MAX_EXP_BUCKET + 1 : exp; }
function expLabel(bucket) { return bucket > MAX_EXP_BUCKET ? `${MAX_EXP_BUCKET + 1}+` : String(bucket); }

function loadRows(positions, extraCols) {
  const ph = positions.map(() => '?').join(',');
  const cols = ['pys.Player_ID', 'pys.Year', 'pys.Games_Played', 'pys.Current_Overall AS OA']
    .concat(extraCols.map(c => `pys."${c}" AS ${c.replace(/[^A-Za-z0-9]/g, '_')}`));
  const sql = `
    SELECT ${cols.join(', ')}, (pys.Year - pi.Draft_Year) AS Exp
    FROM player_year_summary pys JOIN player_information pi ON pi.Player_ID = pys.Player_ID
    WHERE pys.Position IN (${ph}) AND pys.Current_Overall > 0 AND pys.Games_Played >= 4 AND pi.Draft_Year > 0
  `;
  const rows = db.prepare(sql).all(...positions).filter(r => r.Exp >= 0);
  // normalize keys back to original col names (without the sanitized suffix) for the callers
  for (const r of rows) {
    for (const c of extraCols) {
      const safe = c.replace(/[^A-Za-z0-9]/g, '_');
      if (safe !== c) { r[c] = r[safe]; }
    }
  }
  return rows;
}

function printCurve(label, rows, ratingCols, statDefs) {
  console.log(`\n${'='.repeat(100)}\n${label}  (n=${rows.length} player-seasons, Experience = Year - Draft_Year)\n${'='.repeat(100)}`);

  const buckets = {};
  for (const r of rows) {
    const b = bucketExp(r.Exp);
    if (!buckets[b]) buckets[b] = [];
    buckets[b].push(r);
  }
  const bucketKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);

  const header = ['Exp', 'n', 'Avg OA', ...ratingCols, ...statDefs.map(s => s.label)];
  console.log(header.map(h => String(h).padEnd(11)).join(''));

  const peakByCol = {};
  for (const b of bucketKeys) {
    const set = buckets[b];
    const avgOA = set.reduce((a, r) => a + r.OA, 0) / set.length;
    const ratingAvgs = ratingCols.map(c => set.reduce((a, r) => a + r[c], 0) / set.length);
    const statAvgs = statDefs.map(s => set.reduce((a, r) => a + s.fn(r), 0) / set.length);
    const rowOut = [expLabel(b), String(set.length), avgOA.toFixed(1), ...ratingAvgs.map(v => v.toFixed(1)), ...statAvgs.map(v => v.toFixed(3))];
    console.log(rowOut.map(v => String(v).padEnd(11)).join(''));

    // track peak (only among non-tail buckets, min n=15 for stability)
    if (set.length >= 15 && b <= MAX_EXP_BUCKET) {
      const allVals = [avgOA, ...ratingAvgs, ...statAvgs];
      const allLabels = ['Overall', ...ratingCols, ...statDefs.map(s => s.label)];
      allLabels.forEach((l, i) => {
        if (!peakByCol[l] || allVals[i] > peakByCol[l].val) peakByCol[l] = { val: allVals[i], exp: b };
      });
    }
  }
  console.log('\nPeak experience year (min n=15 per bucket):');
  for (const [label, { val, exp }] of Object.entries(peakByCol)) {
    console.log(`  ${label}: peaks at Experience=${expLabel(exp)} (avg=${val.toFixed(2)})`);
  }
}

// ============================================================================
// QB
// ============================================================================
{
  const rows = loadRows(['QB'], ['Accuracy', 'Deep_Passes', 'Pass_Attempts', 'Pass_Completions', 'Passing_Yards']);
  const filtered = rows.filter(r => r.Pass_Attempts >= 100);
  printCurve('QUARTERBACK', filtered, ['Accuracy', 'Deep_Passes'], [
    { label: 'Avg/A', fn: r => r.Passing_Yards / r.Pass_Attempts },
    { label: 'Comp%', fn: r => 100 * r.Pass_Completions / r.Pass_Attempts },
  ]);
}

// ============================================================================
// RB
// ============================================================================
{
  const rows = loadRows(['RB'], ['Hole_Recognition', 'Elusiveness', 'Rushes', 'Rushing_Yards']);
  const filtered = rows.filter(r => r.Rushes >= 20);
  printCurve('RUNNING BACK', filtered, ['Hole_Recognition', 'Elusiveness'], [
    { label: 'Yds/Game', fn: r => r.Rushing_Yards / r.Games_Played },
    { label: 'Avg', fn: r => r.Rushing_Yards / r.Rushes },
  ]);
}

// ============================================================================
// OFFENSIVE LINE (LT/LG/C/RG/RT combined)
// ============================================================================
{
  const rows = loadRows(['LT', 'LG', 'C', 'RG', 'RT'], ['Run_Blocking', 'Key_Run_Blocks', 'Block_Opportunities']);
  const filtered = rows.filter(r => r.Block_Opportunities >= 20);
  printCurve('OFFENSIVE LINE (LT/LG/C/RG/RT)', filtered, ['Run_Blocking'], [
    { label: 'KRB/Game', fn: r => r.Key_Run_Blocks / r.Games_Played },
    { label: 'BPct', fn: r => 100 * r.Key_Run_Blocks / r.Block_Opportunities },
  ]);
}

// ============================================================================
// EDGE RUSHER (LDE/RDE combined)
// ============================================================================
{
  const rows = loadRows(['LDE', 'RDE'], ['Pass_Rush_Technique', 'Sacks_(x10)', 'Hurries']);
  printCurve('EDGE RUSHER (LDE/RDE)', rows, ['Pass_Rush_Technique'], [
    { label: 'Sacks/Game', fn: r => (r['Sacks_(x10)'] * 0.1) / r.Games_Played },
    { label: 'Hurries/Game', fn: r => r.Hurries / r.Games_Played },
  ]);
}

// ============================================================================
// WR (FL/SE combined) — Route_Running/Avoid_Drops chosen by football-domain
// reasoning (not yet empirically validated as top drivers like QB/RB/OL/Edge)
// ============================================================================
{
  const rows = loadRows(['FL', 'SE'], ['Route_Running', 'Avoid_Drops', 'Targets', 'Catches', 'Receiving_Yards']);
  const filtered = rows.filter(r => r.Targets >= 20);
  printCurve('WIDE RECEIVER (FL/SE)', filtered, ['Route_Running', 'Avoid_Drops'], [
    { label: 'Yds/Game', fn: r => r.Receiving_Yards / r.Games_Played },
    { label: 'Catch%', fn: r => 100 * r.Catches / r.Targets },
  ]);
}

// ============================================================================
// TE — same receiving lens as WR for comparability
// ============================================================================
{
  const rows = loadRows(['TE'], ['Route_Running', 'Avoid_Drops', 'Targets', 'Catches', 'Receiving_Yards']);
  const filtered = rows.filter(r => r.Targets >= 20);
  printCurve('TIGHT END', filtered, ['Route_Running', 'Avoid_Drops'], [
    { label: 'Yds/Game', fn: r => r.Receiving_Yards / r.Games_Played },
    { label: 'Catch%', fn: r => 100 * r.Catches / r.Targets },
  ]);
}

// ============================================================================
// LINEBACKER (SLB/WLB/MLB/SILB/WILB combined)
// ============================================================================
{
  const rows = loadRows(['SLB', 'WLB', 'MLB', 'SILB', 'WILB'], ['Run_Defense', 'Play_Diagnosis', 'Tackles', 'Assists', 'Sacks_(x10)']);
  printCurve('LINEBACKER (SLB/WLB/MLB/SILB/WILB)', rows, ['Run_Defense', 'Play_Diagnosis'], [
    { label: 'Tkl/Game', fn: r => (r.Tackles + r.Assists) / r.Games_Played },
    { label: 'Sacks/Game', fn: r => (r['Sacks_(x10)'] * 0.1) / r.Games_Played },
  ]);
}

// ============================================================================
// DEFENSIVE TACKLE (LDT/RDT/NT combined) — same pass-rush lens as Edge
// ============================================================================
{
  const rows = loadRows(['LDT', 'RDT', 'NT'], ['Run_Defense', 'Pass_Rush_Technique', 'Sacks_(x10)', 'Hurries']);
  printCurve('DEFENSIVE TACKLE (LDT/RDT/NT)', rows, ['Run_Defense', 'Pass_Rush_Technique'], [
    { label: 'Sacks/Game', fn: r => (r['Sacks_(x10)'] * 0.1) / r.Games_Played },
    { label: 'Hurries/Game', fn: r => r.Hurries / r.Games_Played },
  ]);
}

// ============================================================================
// CORNERBACK (LCB/RCB combined)
// ============================================================================
{
  const rows = loadRows(['LCB', 'RCB'], ['Man-to-Man_Defense', 'Intercepting', 'Passes_Defensed', 'Interceptions']);
  printCurve('CORNERBACK (LCB/RCB)', rows, ['Man-to-Man_Defense', 'Intercepting'], [
    { label: 'PD/Game', fn: r => r.Passes_Defensed / r.Games_Played },
    { label: 'INT/Game', fn: r => r.Interceptions / r.Games_Played },
  ]);
}

// ============================================================================
// STRONG SAFETY
// ============================================================================
{
  const rows = loadRows(['SS'], ['Zone_Defense', 'Intercepting', 'Passes_Defensed', 'Interceptions', 'Tackles', 'Assists']);
  printCurve('STRONG SAFETY', rows, ['Zone_Defense', 'Intercepting'], [
    { label: 'Tkl/Game', fn: r => (r.Tackles + r.Assists) / r.Games_Played },
    { label: 'INT/Game', fn: r => r.Interceptions / r.Games_Played },
  ]);
}

// ============================================================================
// FREE SAFETY
// ============================================================================
{
  const rows = loadRows(['FS'], ['Zone_Defense', 'Intercepting', 'Passes_Defensed', 'Interceptions', 'Tackles', 'Assists']);
  printCurve('FREE SAFETY', rows, ['Zone_Defense', 'Intercepting'], [
    { label: 'PD/Game', fn: r => r.Passes_Defensed / r.Games_Played },
    { label: 'INT/Game', fn: r => r.Interceptions / r.Games_Played },
  ]);
}

db.close();
