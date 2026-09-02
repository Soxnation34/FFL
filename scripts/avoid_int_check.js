'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(__dirname, '..', 'ffl.db'));

const rows = db.prepare(`
  SELECT pr.Player_ID, pi.First_Name, pi.Last_Name, pr.Experience,
    pp.Current_Overall AS Cur, pp.Current_Screen_Passes AS Screen, pp.Current_Short_Passes AS Short,
    pp.Current_Medium_Passes AS Med, pp.Current_Long_Passes AS Long, pp.Current_Deep_Passes AS Deep,
    pp.Current_Third_Down AS ThirdDown, pp.Current_Accuracy AS Acc, pp.Current_Sense_Rush AS SenseRush,
    pp.Current_Read_Defense AS ReadD, pp."Current_Two-Minute_Offense" AS Twomin
  FROM player_record pr JOIN player_information pi ON pi.Player_ID = pr.Player_ID
  JOIN players_personal pp ON pp.Player_ID = pr.Player_ID
  WHERE pr.Position = 'QB' AND pp.Current_Overall > 0
`).all();

console.log('n =', rows.length);
const withAI = rows.map(r => {
  const ai = (r.Cur*1.000 - r.Screen*0.082 - r.Short*0.078 - r.Med*0.091 - r.Long*0.091 - r.Deep*0.062
    - r.ThirdDown*0.099 - r.Acc*0.095 - r.SenseRush*0.033 - r.ReadD*0.045 - r.Twomin*0.029) / 0.296;
  return Object.assign({}, r, { AI: ai });
});
const aiVals = withAI.map(r => r.AI);
const min = Math.min(...aiVals), max = Math.max(...aiVals);
const mean = aiVals.reduce((a, b) => a + b, 0) / aiVals.length;
console.log('AI range:', min.toFixed(1), 'to', max.toFixed(1), 'mean', mean.toFixed(1));
console.log('out of [0,100] range count:', aiVals.filter(v => v < 0 || v > 100).length, '/', aiVals.length);
console.log('sample:');
for (const r of withAI.slice(0, 10)) {
  console.log(' ', r.First_Name, r.Last_Name, 'Cur=' + r.Cur, 'AI=' + r.AI.toFixed(1));
}

// Correlate AI with real interception avoidance: INT per pass attempt, most recent full season
const statRows = db.prepare(`
  SELECT Player_ID, Pass_Attempts, Intercepted
  FROM player_year_summary
  WHERE Position = 'QB' AND Year = 2075 AND Pass_Attempts >= 100
`).all();
const statMap = new Map(statRows.map(r => [r.Player_ID, r]));
const paired = withAI.filter(r => statMap.has(r.Player_ID)).map(r => {
  const s = statMap.get(r.Player_ID);
  return { AI: r.AI, intPct: 100 * s.Intercepted / s.Pass_Attempts };
});
console.log('\npaired n (2075, Att>=100):', paired.length);
if (paired.length > 2) {
  const n = paired.length;
  const mx = paired.reduce((a, b) => a + b.AI, 0) / n;
  const my = paired.reduce((a, b) => a + b.intPct, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (const p of paired) { cov += (p.AI - mx) * (p.intPct - my); vx += (p.AI - mx) ** 2; vy += (p.intPct - my) ** 2; }
  const r = cov / Math.sqrt(vx * vy);
  console.log('corr(AI, INT%) =', r.toFixed(3), '(expect negative if AI is real)');
}
