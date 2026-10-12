// Uploaded drafted-player list — the user-driven alternative to the UtilitySuite DraftOrder.csv
// live source. The user uploads a file as the draft progresses (any of: DraftAnalyzer's
// DraftOrder.csv, this app's own DraftListPIT.csv export, or a plain list of names, one per line,
// optionally prefixed with a pick number). Every row is matched to a current prospect — by
// Name+Birthdate when a birthdate column is present, otherwise by full name (case-insensitive;
// a name shared by two prospects is reported as ambiguous and skipped). The matched set is
// persisted to drafted-players.json so it survives server restarts, and lib/draftStatus.js
// prefers it over the CSV whenever it holds at least one player.
'use strict';
const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'drafted-players.json');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',' || ch === '\t') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Birthdates in the exports are "M-D-YYYY" with no zero padding; accept slashes/zero-padded input too.
function normDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  return m ? `${Number(m[1])}-${Number(m[2])}-${m[3]}` : String(s || '').trim();
}

function parse(text, prospects) {
  const byKey = new Map(prospects.map(p => [p.identityKey, p]));
  const byName = new Map();
  for (const p of prospects) {
    const k = norm(p.player);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  }

  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const entries = [];
  const unmatched = [];
  const ambiguous = [];
  const seen = new Set();
  if (lines.length === 0) return { entries, unmatched, ambiguous, rows: 0 };

  const headerFields = parseCsvLine(lines[0]);
  const hIdx = Object.fromEntries(headerFields.map((h, i) => [norm(h), i]));
  const pick = keys => keys.map(k => hIdx[k]).find(v => v != null);
  const nameCol = pick(['name', 'player', 'player name']);
  const hasHeader = nameCol != null;
  const dateCol = pick(['birthdate', 'birth date', 'dob']);
  const draftedCol = hIdx['drafted'];
  const orderCol = pick(['draftedorder', 'drafted order', 'pick', 'order', 'overall']);
  const teamCol = pick(['team', 'drafting team', 'drafted by', 'drafted team']);

  const dataLines = hasHeader ? lines.slice(1) : lines;
  dataLines.forEach((line, i) => {
    const f = parseCsvLine(line);
    let name;
    let birthdate = null;
    let order = null;
    let team = null;
    if (hasHeader) {
      name = f[nameCol];
      if (dateCol != null) birthdate = f[dateCol];
      // DraftOrder.csv lists the whole class with a Drafted flag; keep only the drafted rows.
      if (draftedCol != null && !/^(true|1|yes|y)$/i.test(f[draftedCol] || '')) return;
      if (orderCol != null && f[orderCol] !== '' && !isNaN(Number(f[orderCol]))) order = Number(f[orderCol]);
      if (teamCol != null && f[teamCol]) team = f[teamCol];
    } else {
      // FOF8 draft-recap style: "Pick #4 - Pittsburgh - McIntyre, Marquis, QB, Oklahoma State"
      const recap = line.match(/^pick\s*#?\s*(\d+)\s*-\s*(.+?)\s*-\s*([^,]+),\s*([^,]+)/i);
      if (recap) {
        order = Number(recap[1]);
        team = recap[2].trim();
        name = `${recap[4].trim()} ${recap[3].trim()}`;
      } else {
        // Headerless: an optional numeric pick field plus the first field that looks like a name.
        const nums = f.filter(x => /^\d+$/.test(x));
        if (nums.length) order = Number(nums[0]);
        name = f.find(x => x && !/^\d+$/.test(x) && byName.has(norm(x)));
        // "Last, First" split across the first two fields
        if (!name && f.length >= 2 && byName.has(norm(`${f[1]} ${f[0]}`))) name = `${f[1]} ${f[0]}`;
        if (!name) name = f.find(x => x && !/^\d+$/.test(x));
      }
    }
    if (!name) return;
    if (order == null) order = i + 1;

    let hit = null;
    if (birthdate) {
      const sp = name.indexOf(' ');
      const first = sp === -1 ? name : name.slice(0, sp);
      const last = sp === -1 ? '' : name.slice(sp + 1);
      hit = byKey.get(`${first}|${last}|${normDate(birthdate)}`) || null;
    }
    if (!hit) {
      const cands = byName.get(norm(name)) || [];
      if (cands.length === 1) hit = cands[0];
      else if (cands.length > 1) { ambiguous.push(name); return; }
    }
    if (!hit) { unmatched.push(name); return; }
    if (seen.has(hit.playerId)) return;
    seen.add(hit.playerId);
    entries.push({ playerId: hit.playerId, identityKey: hit.identityKey, name: hit.player, order, team });
  });
  return { entries, unmatched, ambiguous, rows: dataLines.length };
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (Array.isArray(data.entries)) return data;
  } catch (e) { /* no upload yet */ }
  return null;
}

function save(record) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(record, null, 2));
}

function clear() {
  try { fs.unlinkSync(STORE_PATH); } catch (e) { /* already gone */ }
}

module.exports = { parse, load, save, clear, STORE_PATH };
