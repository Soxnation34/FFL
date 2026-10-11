// Persisted state for the "Priority Draft List" tab — a single JSON file holding the user's
// curated draft order as an ordered array of Player_IDs. Removal is implicit: a player not
// present in `order` is simply off the list.
//
// This needs to tell "deliberately removed" apart from "genuinely new prospect I haven't seen
// yet" — both look identical as "an ID not in `order`" unless something else is tracked. So the
// file also stores `knownIds`: every Player_ID that existed the last time this was saved. On
// load, only an ID that's in the CURRENT universe but wasn't in `knownIds` counts as new and gets
// appended (sorted by Rating); anything in `knownIds` but missing from `order` was removed on
// purpose and stays removed. `knownIds` itself is refreshed on every save() call.
'use strict';
const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'priority-list.json');

function defaultOrder(prospects) {
  return [...prospects].sort((a, b) => b.rating - a.rating).map(p => p.playerId);
}

function load(prospects) {
  const validIds = new Set(prospects.map(p => p.playerId));
  let saved = [];
  let knownIds = null;
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (Array.isArray(data.order)) saved = data.order.filter(id => validIds.has(id));
    if (Array.isArray(data.knownIds)) knownIds = new Set(data.knownIds);
  } catch (e) {
    // No file yet, or unreadable — fall through to default order.
  }
  // No prior save at all: everything is "new" (first-run default order), not a removal case.
  const known = knownIds || new Set();
  const missing = prospects.filter(p => !known.has(p.playerId)).sort((a, b) => b.rating - a.rating).map(p => p.playerId);
  return [...saved, ...missing];
}

function save(order, prospects) {
  const knownIds = prospects.map(p => p.playerId);
  fs.writeFileSync(STORE_PATH, JSON.stringify({ order, knownIds, savedAt: new Date().toISOString() }, null, 2));
}

module.exports = { load, save, defaultOrder };
