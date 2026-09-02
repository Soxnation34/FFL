// Correlates player ratings against derived performance-rate stats, by position group,
// to see which ratings are associated with which statistical outcomes.
// Usage: node scripts/rating_correlations.js
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, '..', 'ffl.db'));

const RATING_COLS = [
  'Screen_Passes', 'Short_Passes', 'Medium_Passes', 'Long_Passes', 'Deep_Passes',
  'Third_Down', 'Run_Frequency', 'Accuracy', 'Timing', 'Sense_Rush', 'Read_Defense',
  'Two-Minute_Offense', 'Speed', 'Power_Inside', 'Third-Down_Runs', 'Hole_Recognition',
  'Elusiveness', 'Speed_Outside', 'Blitz_Pickup', 'Avoid_Drops', 'Get_Downfield',
  'Route_Running', 'Third-Down_Receiving', 'Big_Play_Receiving', 'Courage', 'Adjust_to_Ball',
  'Punt_Returns:1', 'Kick_Returns:1', 'Run_Blocking', 'Pass_Blocking', 'Blocking_Strength',
  'Punting_Power', 'Hang_Time', 'Directional_Punting', 'Kickoff_Distance', 'Kickoff_Hang_Time',
  'Kicking_Accuracy', 'Kicking_Power', 'Run_Defense', 'Pass_Rush_Technique',
  'Man-to-Man_Defense', 'Zone_Defense', 'Bump-and-Run_Defense', 'Pass_Rush_Strength',
  'Play_Diagnosis', 'Punishing_Hitter', 'Intercepting', 'Endurance', 'Special_Teams',
  'Long_Snapping', 'Kick_Holding', 'Current_Overall',
];

const GROUPS = [
  {
    group: 'QB', positions: ['QB'],
    metrics: [
      { name: 'Completion %', num: 'Pass_Completions', den: 'Pass_Attempts', min: 100 },
      { name: 'Yards / Attempt', num: 'Passing_Yards', den: 'Pass_Attempts', min: 100 },
      { name: 'TD Rate', num: 'Touchdown_Passes', den: 'Pass_Attempts', min: 100 },
      { name: 'INT Rate', num: 'Intercepted', den: 'Pass_Attempts', min: 100 },
      { name: 'Sack Rate', num: 'Sacked', den: 'Pass_Plays', min: 100 },
      { name: 'Rush Yards/Carry (mobile QB)', num: 'Rushing_Yards', den: 'Rushes', min: 15 },
    ],
  },
  {
    group: 'RB/FB', positions: ['RB', 'FB'],
    metrics: [
      { name: 'Yards / Carry', num: 'Rushing_Yards', den: 'Rushes', min: 40 },
      { name: 'Rush TD Rate', num: 'Rushing_Touchdowns', den: 'Rushes', min: 40 },
      { name: 'Catch Rate', num: 'Catches', den: 'Targets', min: 15 },
      { name: 'Yards / Reception', num: 'Receiving_Yards', den: 'Catches', min: 10 },
    ],
  },
  {
    group: 'WR/TE', positions: ['FL', 'SE', 'TE'],
    metrics: [
      { name: 'Catch Rate', num: 'Catches', den: 'Targets', min: 20 },
      { name: 'Yards / Reception (YPC)', num: 'Receiving_Yards', den: 'Catches', min: 15 },
      { name: 'Yards-After-Catch / Reception', num: 'Yards_after_Catch', den: 'Catches', min: 15 },
      { name: 'Drop Rate', num: 'Drops', den: 'Targets', min: 20 },
      { name: 'TD Rate / Catch', num: 'Receiving_Touchdowns', den: 'Catches', min: 15 },
    ],
  },
  {
    group: 'OL', positions: ['C', 'LG', 'RG', 'LT', 'RT'],
    metrics: [
      { name: 'Block Success Rate', num: 'Key_Run_Blocks', den: 'Block_Opportunities', min: 50 },
      { name: 'Sacks-Allowed Rate', num: 'Sacks_Allowed', den: 'Block_Opportunities', min: 50 },
      { name: 'Pancake Rate', num: 'Pancake_Blocks', den: 'Block_Opportunities', min: 50 },
    ],
  },
  {
    group: 'DL', positions: ['LDE', 'RDE', 'LDT', 'RDT', 'NT'],
    metrics: [
      { name: 'Sacks / Game', num: 'Sacks_(x10)', den: 'Games_Played', min: 8, scale: 0.1 },
      { name: 'Tackles / Game', num: 'Tackles', den: 'Games_Played', min: 8 },
      { name: 'Hurries / Game', num: 'Hurries', den: 'Games_Played', min: 8 },
    ],
  },
  {
    group: 'LB', positions: ['WLB', 'SLB', 'MLB', 'SILB', 'WILB'],
    metrics: [
      { name: 'Tackles / Game', num: 'Tackles', den: 'Games_Played', min: 8 },
      { name: 'Sacks / Game', num: 'Sacks_(x10)', den: 'Games_Played', min: 8, scale: 0.1 },
      { name: 'Passes Defensed / Game', num: 'Passes_Defensed', den: 'Games_Played', min: 8 },
      { name: 'Interceptions / Game', num: 'Interceptions', den: 'Games_Played', min: 8 },
    ],
  },
  {
    group: 'DB', positions: ['LCB', 'RCB', 'FS', 'SS'],
    metrics: [
      { name: 'Interceptions / Game', num: 'Interceptions', den: 'Games_Played', min: 8 },
      { name: 'Passes Defensed / Game', num: 'Passes_Defensed', den: 'Games_Played', min: 8 },
      { name: 'Tackles / Game', num: 'Tackles', den: 'Games_Played', min: 8 },
    ],
  },
  {
    group: 'K', positions: ['K'],
    metrics: [
      { name: 'FG %', num: 'Field_Goals_Made', den: 'Field_Goals_Attempted', min: 10 },
      { name: '40+ FG %', num: '40+_Field_Goals_Made', den: '40+_Field_Goals_Attempted', min: 5 },
    ],
  },
  {
    group: 'P', positions: ['P'],
    metrics: [
      { name: 'Gross Punt Avg', num: 'Punting_Yards', den: 'Punts', min: 20 },
      { name: 'Net Punt Avg', num: 'Net_Punting_Yardage', den: 'Punts', min: 20 },
      { name: 'Inside-20 Rate', num: 'Punts_Inside_20', den: 'Punts', min: 20 },
    ],
  },
];

function q(name) {
  return '"' + name.replace(/"/g, '""') + '"';
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

// Partial correlation of x with y, controlling for z (e.g. Current_Overall),
// so we can see whether a specific rating has an effect beyond just "is a good player".
function partialCorr(rxy, rxz, ryz) {
  const denom = Math.sqrt((1 - rxz * rxz) * (1 - ryz * ryz));
  if (denom === 0) return null;
  return (rxy - rxz * ryz) / denom;
}

console.log('Correlations are Pearson r across all qualifying player-seasons.');
console.log('"partial r*" controls for Current_Overall, i.e. the rating\'s association');
console.log('with the stat after removing the effect of just "being a good player".');

for (const g of GROUPS) {
  const placeholders = g.positions.map(() => '?').join(',');
  const neededCols = new Set();
  for (const m of g.metrics) { neededCols.add(m.num); neededCols.add(m.den); }
  for (const r of RATING_COLS) neededCols.add(r);
  const selectCols = [...neededCols].map(q).join(', ');

  const sql = `SELECT ${selectCols} FROM player_year_summary
               WHERE Position IN (${placeholders}) AND Current_Overall IS NOT NULL`;
  const rows = db.prepare(sql).all(...g.positions);

  console.log(`\n${'='.repeat(70)}\n${g.group}  (n=${rows.length} player-seasons with ratings on file)\n${'='.repeat(70)}`);

  for (const m of g.metrics) {
    const den = m.den, num = m.num, scale = m.scale || 1;
    const eligible = rows.filter(r => (r[den] || 0) >= m.min);
    const values = eligible.map(r => ((r[num] || 0) * scale) / r[den]);

    const overall = eligible.map(r => r.Current_Overall);
    const results = [];
    for (const rating of RATING_COLS) {
      const xs = [], ys = [], zs = [];
      for (let i = 0; i < eligible.length; i++) {
        const rv = eligible[i][rating];
        if (rv === null || rv === undefined) continue;
        xs.push(rv);
        ys.push(values[i]);
        zs.push(overall[i]);
      }
      const r = pearson(xs, ys);
      if (r === null) continue;
      let partial = null;
      if (rating !== 'Current_Overall') {
        const rxz = pearson(xs, zs);
        const ryz = pearson(ys, zs);
        if (rxz !== null && ryz !== null) partial = partialCorr(r, rxz, ryz);
      }
      results.push({ rating, r, partial, n: xs.length });
    }
    results.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    const top = results.filter(x => x.n >= 100).slice(0, 6);

    console.log(`\n  ${m.name}  (n=${eligible.length}, min ${m.den}>=${m.min})`);
    console.log(`    ${'raw r'.padEnd(8)} ${'partial r*'.padEnd(11)} rating`);
    for (const t of top) {
      const pStr = t.partial === null ? '   --  ' : `${t.partial >= 0 ? '+' : ''}${t.partial.toFixed(3)}`;
      console.log(`    ${(t.r >= 0 ? '+' : '') + t.r.toFixed(3)}   ${pStr.padEnd(11)} ${t.rating}`);
    }
  }
}

db.close();
