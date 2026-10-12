// FFL Draft Board — local live server. No external dependencies (built-in http/fs only), matching
// this project's existing convention of using only Node's built-ins (node:sqlite included).
//
// Usage: node server.js   (then open http://localhost:4700)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const pools = require('./lib/pools.js');
const { loadDraftStatus, draftedInfoFor } = require('./lib/draftStatus.js');
const priorityList = require('./lib/priorityList.js');
const draftedUpload = require('./lib/draftedUpload.js');
const favorites = require('./lib/favorites.js');

const PORT = process.env.PORT || 4700;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function annotateDrafted(board, status) {
  const favs = favorites.load();
  return board.map(c => ({ ...c, draftStatus: draftedInfoFor(c.identityKey, status), favorite: favs.has(c.playerId) }));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2_000_000) { reject(new Error('Request body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function priorityListPlayers() {
  const prospects = pools.getAllProspects();
  const order = priorityList.load(prospects);
  const byId = new Map(prospects.map(p => [p.playerId, p]));
  const status = loadDraftStatus();
  const favs = favorites.load();
  return order.map(id => byId.get(id)).filter(Boolean).map(pl => ({ ...pl, draftStatus: draftedInfoFor(pl.identityKey, status), favorite: favs.has(pl.playerId) }));
}

function csvField(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/api/groups') {
      return sendJson(res, 200, pools.listGroups());
    }

    const boardMatch = p.match(/^\/api\/board\/([A-Za-z]+)$/);
    if (req.method === 'GET' && boardMatch) {
      const key = boardMatch[1].toUpperCase();
      try {
        const board = pools.getBoard(key);
        const status = loadDraftStatus();
        return sendJson(res, 200, { key, generatedAt: new Date().toISOString(), players: annotateDrafted(board, status) });
      } catch (e) {
        return sendJson(res, 404, { error: e.message });
      }
    }

    if (req.method === 'GET' && p === '/api/status') {
      const status = loadDraftStatus();
      let matched = 0, total = 0, drafted = 0;
      for (const g of pools.listGroups()) {
        if (g.key === 'PRIORITY' || g.key === 'DRAFTED') continue; // every prospect already counted via its real position board
        const board = pools.getBoard(g.key);
        for (const c of board) {
          total++;
          const info = draftedInfoFor(c.identityKey, status);
          if (info.matched) matched++;
          if (info.drafted) drafted++;
        }
      }
      return sendJson(res, 200, {
        source: status.source,
        uploadFilename: status.uploadFilename || null,
        unmatched: status.unmatched || [],
        ambiguous: status.ambiguous || [],
        csvAvailable: status.available,
        csvError: status.error || null,
        csvPath: status.path,
        csvMtime: status.mtime,
        csvPickCount: status.pickCount,
        csvTotalRows: status.totalRows,
        matched,
        total,
        drafted,
        stale: status.source === 'csv' && status.available && total > 0 && matched / total < 0.5,
      });
    }

    // ---------- Draft Results (who was drafted, by which team) ----------
    if (req.method === 'GET' && p === '/api/drafted') {
      const status = loadDraftStatus();
      const favs = favorites.load();
      const players = [];
      for (const pl of pools.getAllProspects()) {
        const info = draftedInfoFor(pl.identityKey, status);
        if (!info.drafted) continue;
        players.push({ ...pl, draftStatus: info, favorite: favs.has(pl.playerId), pick: info.draftedOrder, draftedTeam: info.team });
      }
      players.sort((a, b) => (a.pick ?? 1e9) - (b.pick ?? 1e9) || a.player.localeCompare(b.player));
      const counts = new Map();
      for (const pl of players) if (pl.draftedTeam) counts.set(pl.draftedTeam, (counts.get(pl.draftedTeam) || 0) + 1);
      const teams = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
      return sendJson(res, 200, { players, teams, source: status.source, hasTeams: teams.length > 0 });
    }

    // ---------- Favorites (star marks) ----------
    if (req.method === 'POST' && p === '/api/favorites') {
      const body = await readJsonBody(req);
      const id = Number(body.playerId);
      if (!Number.isFinite(id) || typeof body.favorite !== 'boolean') return sendJson(res, 400, { error: '"playerId" (number) and "favorite" (boolean) are required' });
      if (!pools.getAllProspects().some(pl => pl.playerId === id)) return sendJson(res, 404, { error: 'Unknown prospect' });
      const count = favorites.setFavorite(id, body.favorite);
      return sendJson(res, 200, { ok: true, count });
    }

    // ---------- Uploaded drafted-player list ----------
    if (req.method === 'POST' && p === '/api/drafted/upload') {
      const body = await readJsonBody(req);
      if (typeof body.text !== 'string' || !body.text.trim()) return sendJson(res, 400, { error: '"text" (file contents) is required' });
      const parsed = draftedUpload.parse(body.text, pools.getAllProspects());
      if (parsed.entries.length === 0) return sendJson(res, 400, { error: 'No current prospects matched that file', ...parsed });
      draftedUpload.save({ ...parsed, filename: body.filename || null, uploadedAt: new Date().toISOString() });
      return sendJson(res, 200, { ok: true, drafted: parsed.entries.length, rows: parsed.rows, unmatched: parsed.unmatched, ambiguous: parsed.ambiguous });
    }

    if (req.method === 'POST' && p === '/api/drafted/clear') {
      draftedUpload.clear();
      return sendJson(res, 200, { ok: true });
    }

    // ---------- Priority Draft List ----------
    if (req.method === 'GET' && p === '/api/priority-list') {
      return sendJson(res, 200, { players: priorityListPlayers() });
    }

    if (req.method === 'POST' && p === '/api/priority-list') {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.order)) return sendJson(res, 400, { error: '"order" must be an array of Player_IDs' });
      const allProspects = pools.getAllProspects();
      const validIds = new Set(allProspects.map(pl => pl.playerId));
      const order = body.order.filter(id => validIds.has(id));
      priorityList.save(order, allProspects);
      return sendJson(res, 200, { ok: true, count: order.length });
    }

    if (req.method === 'POST' && p === '/api/priority-list/reset') {
      const allProspects = pools.getAllProspects();
      const order = priorityList.defaultOrder(allProspects);
      priorityList.save(order, allProspects);
      return sendJson(res, 200, { ok: true, count: order.length });
    }

    if (req.method === 'GET' && p === '/api/priority-list/export.csv') {
      const players = priorityListPlayers().filter(pl => !pl.draftStatus?.drafted);
      const lines = ['Name,Position,BirthDate'];
      for (const pl of players) lines.push(`${csvField(pl.player)},${csvField(pl.nativePosition)},${csvField(pl.birthDate)}`);
      const csv = lines.join('\r\n') + '\r\n';
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="DraftListPIT.csv"',
        'Content-Length': Buffer.byteLength(csv),
      });
      return res.end(csv);
    }

    if (req.method !== 'GET') { res.writeHead(405); return res.end('Method not allowed'); }

    return serveStatic(req, res, p);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`FFL Draft Board running at http://localhost:${PORT}`);
});
