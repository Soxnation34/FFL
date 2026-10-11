// Live drafted-status source: the StelmackSoft DraftAnalyzer's own DraftOrder.csv export, which
// updates in place as picks are made during the actual live draft (this is the one place
// "who's off the board so far" actually lives — ffl.db is a slower, less-frequently-rebuilt
// snapshot, see README.md in the FFL folder). Re-read fresh (cheap: one flat CSV, re-parsed only
// when its mtime changes) on every request so the board reflects the draft as it happens.
//
// Matching a CSV row to a ffl.db Player_ID uses the same Name+Birthdate identity key as
// export_draft_order_phi.js, for the same reason documented in Draft_Methodology.md: bare-name
// matching risks colliding with an unrelated player from decades of simulated history, and
// Birthdate (present in both sources, same "M-D-YYYY" no-zero-pad format) resolves that.
'use strict';
const fs = require('fs');
const draftedUpload = require('./draftedUpload.js');

const CSV_PATH = 'C:\\Users\\soxna\\OneDrive\\Documents\\StelmackSoft\\UtilitySuite\\DraftOrder.csv';

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
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

let cache = null; // { mtimeMs, result }

function loadDraftStatus() {
  // An uploaded drafted-player list (lib/draftedUpload.js) takes precedence over the CSV.
  const upload = draftedUpload.load();
  if (upload && upload.entries.length) {
    const map = new Map();
    for (const e of upload.entries) map.set(e.identityKey, { drafted: true, draftedOrder: e.order ?? null });
    return {
      available: true, source: 'upload', path: draftedUpload.STORE_PATH, map,
      pickCount: upload.entries.length, totalRows: upload.rows || upload.entries.length,
      mtime: upload.uploadedAt, uploadFilename: upload.filename || null,
      unmatched: upload.unmatched || [], ambiguous: upload.ambiguous || [],
    };
  }
  return loadCsvStatus();
}

function loadCsvStatus() {
  let stat;
  try {
    stat = fs.statSync(CSV_PATH);
  } catch (e) {
    return { available: false, source: 'csv', error: e.message, path: CSV_PATH, map: new Map(), pickCount: 0, totalRows: 0, mtime: null };
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.result;

  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const map = new Map();
  let pickCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const name = f[idx.Name];
    if (!name) continue;
    const birthdate = f[idx.Birthdate];
    const drafted = f[idx.Drafted] === 'True';
    const draftedOrderRaw = Number(f[idx.DraftedOrder]);
    if (drafted) pickCount++;
    const spaceIdx = name.indexOf(' ');
    const first = spaceIdx === -1 ? name : name.slice(0, spaceIdx);
    const last = spaceIdx === -1 ? '' : name.slice(spaceIdx + 1);
    const key = `${first}|${last}|${birthdate}`;
    map.set(key, {
      drafted,
      draftedOrder: drafted && draftedOrderRaw >= 0 ? draftedOrderRaw : null,
    });
  }

  const result = {
    available: true,
    source: 'csv',
    path: CSV_PATH,
    map,
    pickCount,
    totalRows: lines.length - 1,
    mtime: stat.mtime.toISOString(),
  };
  cache = { mtimeMs: stat.mtimeMs, result };
  return result;
}

function draftedInfoFor(identityKey, status) {
  if (!identityKey || !status.available) return { drafted: false, draftedOrder: null, matched: false };
  const hit = status.map.get(identityKey);
  return hit ? { drafted: hit.drafted, draftedOrder: hit.draftedOrder, matched: true } : { drafted: false, draftedOrder: null, matched: false };
}

module.exports = { loadDraftStatus, draftedInfoFor, CSV_PATH };
