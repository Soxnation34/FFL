// Ranks coaching candidates for Pittsburgh (Team 22) ahead of the FOF8 staff draft,
// using the user's coach rating tier list (CoachTierList.txt, the "coach rating bible").
// Run with: node scripts/rank_coaching_candidates.js
// Writes coaching_candidates_top7.csv (same shape as the CFL version) and prints a report.
//
// Pool rules (FOF8 staff draft):
//   Free Agent        - unemployed, not retired (Current_Team 99)
//   Expiring (Role)   - on another team with 0 years left and NOT re-signed in Pre-Staff Draft
//   Poachable (Role)  - under contract elsewhere in a LOWER role; FOF8 lets you hire away for a promotion
//
// Score = tier-weighted average of the ratings the user values for that role (S=5 A=4 B=3 C=2 D=1)
//         minus 2 pts per year of age past 62 (retirement risk).
// Filters: OC must be West Coast (Offensive_Style 3) with playbook limit (Offensive_Plays) >= 65;
//          DC must be 43 Over (Defensive_Front 4).
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const db = new DatabaseSync(path.join(ROOT, 'ffl.db'), { readOnly: true });
const MY_TEAM = 22;
const TOP_N = 7;
const AGE_LIMIT = 62, AGE_PEN_PER_YEAR = 2;

// Code tables (order taken from the FOF8 executable's string table; staff.csv codes are 1-based, 0 = none)
const OFF_STYLE = { 0: '-', 1: 'Smashmouth', 2: 'Balanced', 3: 'West Coast', 4: 'Air Coryell', 5: 'Erhardt-Perkins', 6: 'Spread' };
const DEF_FRONT = { 0: '-', 1: 'True 34', 2: '34 Eagle', 3: '43 Under', 4: '43 Over' };
const REQ_OFF_STYLE = 3;      // West Coast
const REQ_DEF_FRONT = 4;      // 43 Over
const MIN_PLAYBOOK = 65;      // Offensive_Plays

const TIER = { S: 5, A: 4, B: 3, C: 2, D: 1 };
const HC_TIERS = { Discipline: 'S', Scouting_Ability: 'A', Motivation: 'B', Young_Player_Development: 'B', Player_Development: 'B', Interviewing: 'D', Play_Calling: 'D' };
const COORD_TIERS = { Scouting_Ability: 'S', Play_Calling: 'A', Young_Player_Development: 'B', Player_Development: 'B', Discipline: 'C', Motivation: 'D', Interviewing: 'D' };
const TIERS = {
  'Head Coach': HC_TIERS,
  'Offensive Coordinator': COORD_TIERS,
  'Defensive Coordinator': COORD_TIERS,
  'Assistant Coach': HC_TIERS,                       // "Assistant Head Coach" in the tier list
  'Strength Coordinator': { Strength_Training: 'S', Conditioning: 'S' },
};
const RANK = { 'Head Coach': 3, 'Offensive Coordinator': 2, 'Defensive Coordinator': 2, 'Assistant Coach': 1, 'Strength Coordinator': 0, 'None': -1 };

const staff = db.prepare('SELECT * FROM staff WHERE Retired = 0').all();

function source(s, target) {
  if (s.Current_Team === MY_TEAM) return null;
  if (s.Current_Team === 99) return 'Free Agent';
  if (s.Years_on_Contract === 0) return `Expiring (${s.Role})`;
  if (target === 'Strength Coordinator' || s.Role === 'Strength Coordinator') return null;
  if (RANK[s.Role] < RANK[target]) return `Poachable (${s.Role})`;
  return null;
}

function passesFilter(s, target) {
  if (target === 'Offensive Coordinator') return s.Offensive_Style === REQ_OFF_STYLE && s.Offensive_Plays >= MIN_PLAYBOOK;
  if (target === 'Defensive Coordinator') return s.Defensive_Front === REQ_DEF_FRONT;
  return true;
}

function score(s, target) {
  const tiers = TIERS[target];
  let num = 0, den = 0;
  for (const k in tiers) { num += TIER[tiers[k]] * (s[k] || 0); den += TIER[tiers[k]]; }
  const blend = num / den;
  const agePen = Math.max(0, s.Age - AGE_LIMIT) * AGE_PEN_PER_YEAR;
  return { score: Math.round((blend - agePen) * 10) / 10, blend: Math.round(blend * 10) / 10, agePen };
}

const rows = [];
const detail = {};
for (const target of Object.keys(TIERS)) {
  const cands = [];
  for (const s of staff) {
    const isStrength = s.Primary_Group === 'Strength';
    if ((target === 'Strength Coordinator') !== isStrength) continue;
    const src = source(s, target);
    if (!src) continue;
    if (!passesFilter(s, target)) continue;
    cands.push({ s, src, ...score(s, target) });
  }
  cands.sort((a, b) => b.score - a.score);
  detail[target] = cands;
  cands.slice(0, TOP_N).forEach((c, i) => rows.push([target, i + 1, `${c.s.First_Name} ${c.s.Last_Name}`, c.s.Age, c.src, c.score]));
}

const csv = ['"Position","Rank","Name","Age","Source","Score"']
  .concat(rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')))
  .join('\n') + '\n';
fs.writeFileSync(path.join(ROOT, 'coaching_candidates_top7.csv'), csv);

const pad = (v, n) => String(v ?? '').padEnd(n);
const abbr = k => k.replace(/_/g, '').replace(/[a-z]/g, '');
console.log('Pittsburgh current staff (scored on the same tier list):');
for (const s of staff.filter(x => x.Current_Team === MY_TEAM).sort((a, b) => RANK[b.Role] - RANK[a.Role])) {
  const r = score(s, s.Role);
  const flags = s.Role === 'Offensive Coordinator' ? ` ${OFF_STYLE[s.Offensive_Style]} PB${s.Offensive_Plays}` : s.Role === 'Defensive Coordinator' ? ` ${DEF_FRONT[s.Defensive_Front]}` : '';
  console.log(`  ${pad(s.Role, 23)} ${pad(s.First_Name + ' ' + s.Last_Name, 18)} age ${s.Age}  yrs left ${s.Years_on_Contract}  score ${r.score}${flags}${r.agePen ? ` (age pen -${r.agePen})` : ''}`);
}
const missing = Object.keys(TIERS).filter(r => !staff.some(s => s.Current_Team === MY_TEAM && s.Role === r));
console.log(`  VACANT: ${missing.join(', ') || 'none'}\n`);

for (const target of Object.keys(TIERS)) {
  const filt = target === 'Offensive Coordinator' ? ` | filter: West Coast & playbook >= ${MIN_PLAYBOOK}` : target === 'Defensive Coordinator' ? ' | filter: 43 Over' : '';
  console.log(`=== ${target} (eligible ${detail[target].length}${filt}) ===`);
  console.log('  ' + pad('#', 3) + pad('Name', 20) + pad('Age', 4) + pad('Source', 34) + pad('Score', 7) + pad('Tm', 4) + 'Ratings (tier order)');
  for (const [i, c] of detail[target].slice(0, TOP_N).entries()) {
    const s = c.s;
    const keys = Object.keys(TIERS[target]).map(k => `${abbr(k)}${s[k]}`).join(' ');
    const extra = target === 'Offensive Coordinator' ? ` PB${s.Offensive_Plays}` : '';
    console.log('  ' + pad(i + 1, 3) + pad(s.First_Name + ' ' + s.Last_Name, 20) + pad(s.Age, 4) + pad(c.src, 34) + pad(c.score, 7) + pad(s.Current_Team, 4) + keys + extra + (c.agePen ? ` agePen-${c.agePen}` : ''));
  }
  console.log();
}
console.log('Wrote coaching_candidates_top7.csv');
