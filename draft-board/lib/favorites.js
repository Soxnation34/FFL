// Persisted "favorite / starred" marks for draft prospects — a single JSON file holding the
// Player_IDs the user has starred. Independent of the Priority Draft List order (a player can be
// starred without being on the list, and removing someone from the list does not unstar them).
'use strict';
const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'favorites.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (Array.isArray(data.ids)) return new Set(data.ids);
  } catch (e) { /* no file yet */ }
  return new Set();
}

function setFavorite(playerId, favorite) {
  const ids = load();
  if (favorite) ids.add(playerId);
  else ids.delete(playerId);
  fs.writeFileSync(STORE_PATH, JSON.stringify({ ids: [...ids], savedAt: new Date().toISOString() }, null, 2));
  return ids.size;
}

module.exports = { load, setFavorite, STORE_PATH };
