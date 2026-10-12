'use strict';

const state = {
  groups: [],
  currentKey: null,
  players: [],
  sortKey: 'rating',
  sortDir: -1,
  search: '',
  hideDrafted: true,
  favoritesOnly: false,
  draftTeam: '',
  draftTeams: [],
  drawerPlayerId: null,
  // Priority-list-only view/export filter — Set of positionGroup codes to HIDE. Empty = show all.
  priorityPositionExcluded: new Set(),
};

const POSITION_GROUP_LABELS = {
  QB: 'Quarterback', RB: 'Running Back', FB: 'Fullback', WR: 'Wide Receiver', TE: 'Tight End',
  T: 'Tackle', G: 'Guard', C: 'Center', DE: 'Defensive End', DT: 'Defensive Tackle',
  OLB: 'Outside Linebacker', ILB: 'Inside Linebacker', CB: 'Cornerback', S: 'Safety',
  K: 'Kicker', P: 'Punter', LS: 'Long Snapper',
};

const fmt = {
  int: v => (v == null ? '—' : Math.round(v).toString()),
  f1: v => (v == null || Number.isNaN(v) ? '—' : v.toFixed(1)),
  f2: v => (v == null || Number.isNaN(v) ? '—' : v.toFixed(2)),
  dash: v => (v == null || v === 0 ? '—' : (v / 100).toFixed(2)),
  agility: v => (v == null || v === 0 ? '—' : (v / 100).toFixed(2)),
  height: v => (v == null || v === 0 ? '—' : `${Math.floor(v / 12)}'${v % 12}"`),
};

const COLUMNS = [
  { key: '__rank', label: '#', num: true, val: r => r.__rank },
  { key: 'player', label: 'Name', num: false, val: r => r.player },
  { key: 'nativePosition', label: 'Native', num: false, val: r => r.nativePosition },
  { key: 'ratedPosition', label: 'Rated', num: false, val: r => r.ratedPosition },
  { key: 'height', label: 'Ht', num: true, val: r => r.height, format: fmt.height },
  { key: 'weight', label: 'Wt', num: true, val: r => r.weight, format: fmt.int },
  { key: 'dash', label: '40', num: true, val: r => r.dash, format: fmt.dash },
  { key: 'solecismic', label: 'Solec', num: true, val: r => r.combine.solecismic, format: fmt.int },
  { key: 'bench', label: 'Bench', num: true, val: r => r.combine.bench, format: fmt.int },
  { key: 'agility', label: 'Agility', num: true, val: r => r.combine.agility, format: fmt.agility },
  { key: 'broadJump', label: 'Broad Jmp', num: true, val: r => r.combine.broadJump, format: fmt.int },
  { key: 'positionDrill', label: 'Pos Drill', num: true, val: r => r.combine.positionDrill, format: fmt.int },
  { key: 'developed', label: 'Dev%', num: true, val: r => r.developed, format: fmt.int },
  { key: 'volatility', label: 'Vol', num: true, val: r => r.volatility, format: fmt.int },
  { key: 'combineSum', label: 'CombineSum', num: true, val: r => r.combineSum, format: fmt.f2 },
  { key: 'rating', label: 'Rating', num: true, val: r => r.rating, format: fmt.f2 },
  { key: 'exploScore', label: 'Explo Score', num: true, val: r => r.explosiveness?.score ?? null, format: fmt.f1 },
  { key: 'exploPct', label: 'Explo %ile', num: true, val: r => r.explosiveness?.percentile ?? null, format: fmt.f1 },
  { key: 'college', label: 'College', num: false, val: r => r.college },
];
for (const c of COLUMNS) if (!c.format) c.format = v => (v == null ? '—' : String(v));

const PRIORITY_KEY = 'PRIORITY';
const DRAFTED_KEY = 'DRAFTED';
const DRAFTED_COLUMNS = [
  { key: 'pick', label: 'Pick', num: true, val: r => r.pick, format: v => (v == null ? '—' : '#' + v) },
  { key: 'draftedTeam', label: 'Team', num: false, val: r => r.draftedTeam, format: v => v || '—' },
  { key: 'player', label: 'Name', num: false, val: r => r.player },
  { key: 'nativePosition', label: 'Pos', num: false, val: r => r.nativePosition },
  { key: 'ratedPosition', label: 'Rated', num: false, val: r => r.ratedPosition },
  { key: 'height', label: 'Ht', num: true, val: r => r.height, format: v => fmt.height(v) },
  { key: 'weight', label: 'Wt', num: true, val: r => r.weight, format: fmt.int },
  { key: 'dash', label: '40', num: true, val: r => r.dash, format: fmt.dash },
  { key: 'developed', label: 'Dev%', num: true, val: r => r.developed, format: fmt.int },
  { key: 'volatility', label: 'Vol', num: true, val: r => r.volatility, format: fmt.int },
  { key: 'rating', label: 'Rating', num: true, val: r => r.rating, format: fmt.f2 },
  { key: 'college', label: 'College', num: false, val: r => r.college },
];
for (const c of DRAFTED_COLUMNS) if (!c.format) c.format = v => (v == null ? '—' : String(v));
function getColumns() {
  if (state.currentKey === DRAFTED_KEY) return DRAFTED_COLUMNS;
  if (state.currentKey !== PRIORITY_KEY) return COLUMNS;
  return [{ key: '__controls', label: '', num: false, val: () => '' }, ...COLUMNS];
}

// ---------- Data fetching ----------
async function fetchGroups() {
  const res = await fetch('/api/groups');
  state.groups = await res.json();
}
async function fetchBoard(key) {
  const url = key === PRIORITY_KEY ? '/api/priority-list' : key === DRAFTED_KEY ? '/api/drafted' : `/api/board/${key}`;
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `Server returned ${res.status}`;
    try { const err = await res.json(); if (err.error) msg = err.error; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  if (!Array.isArray(data.players)) throw new Error('Malformed response from server (no players array)');
  state.players = data.players;
  if (key === DRAFTED_KEY) {
    state.draftTeams = data.teams || [];
    state.draftHasTeams = !!data.hasTeams;
    renderTeamFilter();
  }
}
function renderTeamFilter() {
  const sel = document.getElementById('teamFilter');
  if (!state.draftTeams.some(t => t.name === state.draftTeam)) state.draftTeam = '';
  sel.innerHTML = `<option value="">All teams (${state.players.length})</option>` + state.draftTeams.map(t => `<option value="${t.name.replace(/"/g, '&quot;')}">${t.name} (${t.count})</option>`).join('');
  sel.value = state.draftTeam;
}
async function fetchStatus() {
  const res = await fetch('/api/status');
  return res.json();
}
async function persistPriorityOrder() {
  try {
    await fetch('/api/priority-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: state.players.map(p => p.playerId) }),
    });
  } catch (e) {
    alert(`Couldn't save the priority list order: ${e.message}\n\nYour change is still shown, but reload the page and it may be lost — check the server is running.`);
  }
}
function sortPriority(key) {
  const col = COLUMNS.find(c => c.key === key);
  if (!col) return;
  if (state.sortKey === key) state.sortDir *= -1;
  else { state.sortKey = key; state.sortDir = key === 'player' || key === 'college' || key === 'nativePosition' || key === 'ratedPosition' || key === 'draftedTeam' ? 1 : -1; }
  state.players.sort((a, b) => {
    const av = col.val(a), bv = col.val(b);
    if (av == null && bv == null) return a.player.localeCompare(b.player);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return state.sortDir * av.localeCompare(bv);
    return (av - bv) * state.sortDir;
  });
  renderTable();
  persistPriorityOrder();
}
function movePriorityPlayer(playerId, delta) {
  const idx = state.players.findIndex(p => p.playerId === playerId);
  const swapIdx = idx + delta;
  if (idx === -1 || swapIdx < 0 || swapIdx >= state.players.length) return;
  [state.players[idx], state.players[swapIdx]] = [state.players[swapIdx], state.players[idx]];
  renderTable();
  persistPriorityOrder();
}
// Drag-and-drop reorder: put draggedId immediately before (or after) targetId in the FULL list,
// so it works the same while rows are hidden by the drafted / search / position filters.
function dragMovePriorityPlayer(draggedId, targetId, placeAfter) {
  if (draggedId === targetId) return;
  const from = state.players.findIndex(p => p.playerId === draggedId);
  if (from === -1) return;
  const [moved] = state.players.splice(from, 1);
  const to = state.players.findIndex(p => p.playerId === targetId);
  if (to === -1) { state.players.splice(from, 0, moved); return; }
  state.players.splice(placeAfter ? to + 1 : to, 0, moved);
  renderTable();
  persistPriorityOrder();
}
function wirePriorityDragAndDrop(body) {
  const wrap = document.querySelector('.table-wrap');
  let draggedId = null;
  const clearMarks = () => body.querySelectorAll('.drop-above, .drop-below').forEach(el => el.classList.remove('drop-above', 'drop-below'));
  body.querySelectorAll('tr[data-player-id]').forEach(tr => {
    tr.draggable = true;
    tr.addEventListener('dragstart', e => {
      draggedId = Number(tr.dataset.playerId);
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(draggedId));
    });
    tr.addEventListener('dragend', () => {
      draggedId = null;
      tr.classList.remove('dragging');
      clearMarks();
    });
    tr.addEventListener('dragover', e => {
      if (draggedId == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = tr.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      clearMarks();
      if (Number(tr.dataset.playerId) !== draggedId) tr.classList.add(after ? 'drop-below' : 'drop-above');
      // Auto-scroll the table when dragging near its top/bottom edge
      if (wrap) {
        const wr = wrap.getBoundingClientRect();
        if (e.clientY < wr.top + 70) wrap.scrollTop -= 22;
        else if (e.clientY > wr.bottom - 70) wrap.scrollTop += 22;
      }
    });
    tr.addEventListener('drop', e => {
      if (draggedId == null) return;
      e.preventDefault();
      const rect = tr.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      const id = draggedId;
      draggedId = null;
      clearMarks();
      dragMovePriorityPlayer(id, Number(tr.dataset.playerId), after);
    });
  });
}
// ---------- Favorites (star marks) ----------
function starButtonHtml(r, extraCls) {
  const on = !!r.favorite;
  return `<button type="button" class="star-btn${on ? ' on' : ''}${extraCls ? ' ' + extraCls : ''}" data-star-id="${r.playerId}" title="${on ? 'Remove from favorites' : 'Mark as favorite'}" aria-label="${on ? 'Remove from favorites' : 'Mark as favorite'}" aria-pressed="${on}">${on ? '&#9733;' : '&#9734;'}</button>`;
}
async function toggleFavorite(playerId) {
  const r = state.players.find(p => p.playerId === playerId);
  if (!r) return;
  const next = !r.favorite;
  r.favorite = next;
  renderTable();
  if (state.drawerPlayerId === playerId && !document.getElementById('drawer').hidden) openDrawer(playerId);
  try {
    const res = await fetch('/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId, favorite: next }) });
    if (!res.ok) throw new Error((await res.json()).error || `Server returned ${res.status}`);
  } catch (e) {
    r.favorite = !next;
    renderTable();
    if (state.drawerPlayerId === playerId && !document.getElementById('drawer').hidden) openDrawer(playerId);
    alert(`Couldn't save the favorite: ${e.message}`);
  }
}
function wireStarButtons(root) {
  root.querySelectorAll('.star-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); toggleFavorite(Number(btn.dataset.starId)); });
    btn.addEventListener('mousedown', e => e.stopPropagation());
  });
}

function removePriorityPlayer(playerId) {
  state.players = state.players.filter(p => p.playerId !== playerId);
  renderTable();
  persistPriorityOrder();
}
async function resetPriorityList() {
  if (!confirm('Reset the Priority Draft List? This restores the default rating order and brings back every player you removed.')) return;
  const btn = document.getElementById('resetListBtn');
  btn.disabled = true;
  try {
    await fetch('/api/priority-list/reset', { method: 'POST' });
    await fetchBoard(PRIORITY_KEY);
    renderPositionFilterPanel();
    renderTable();
  } catch (e) {
    alert(`Reset failed: ${e.message}`);
  }
  btn.disabled = false;
}
function csvField(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function exportPriorityList() {
  // Client-side, from the currently filtered/sorted rows — WYSIWYG with what's on screen
  // (hide-drafted, search, and the position filter all apply), per user request 2026-08-18.
  const rows = getFilteredSorted();
  const lines = ['Name,Position,BirthDate'];
  for (const pl of rows) lines.push(`${csvField(pl.player)},${csvField(pl.nativePosition)},${csvField(pl.birthDate)}`);
  const csv = lines.join('\r\n') + '\r\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'DraftListPIT.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Priority list: position filter dropdown ----------
function priorityPositionGroups() {
  const groups = new Set(state.players.map(p => p.positionGroup));
  return [...groups].sort((a, b) => (POSITION_GROUP_LABELS[a] || a).localeCompare(POSITION_GROUP_LABELS[b] || b));
}
function updatePositionFilterBtnLabel() {
  const total = priorityPositionGroups().length;
  const shown = total - state.priorityPositionExcluded.size;
  document.getElementById('positionFilterBtn').textContent = `Positions (${shown}/${total}) ▾`;
}
function renderPositionFilterPanel() {
  const list = document.getElementById('positionFilterList');
  const groups = priorityPositionGroups();
  list.innerHTML = groups.map(g => {
    const checked = !state.priorityPositionExcluded.has(g);
    const count = state.players.filter(p => p.positionGroup === g).length;
    return `<label class="dropdown-check"><input type="checkbox" data-group="${g}" ${checked ? 'checked' : ''}><span>${POSITION_GROUP_LABELS[g] || g}</span><span class="dc-count">${count}</span></label>`;
  }).join('');
  list.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const g = cb.dataset.group;
      if (cb.checked) state.priorityPositionExcluded.delete(g);
      else state.priorityPositionExcluded.add(g);
      updatePositionFilterBtnLabel();
      renderTable();
    });
  });
  updatePositionFilterBtnLabel();
}

// ---------- Rendering: nav ----------
function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  const families = ['Tools', 'Offense', 'Defense', 'Special Teams'];
  for (const fam of families) {
    const header = document.createElement('div');
    header.className = 'nav-family';
    header.textContent = fam;
    nav.appendChild(header);
    for (const g of state.groups.filter(x => x.family === fam)) {
      const btn = document.createElement('button');
      btn.className = 'nav-item' + (g.key === state.currentKey ? ' active' : '');
      btn.innerHTML = `<span class="nav-item-label"><span class="nav-dot"></span><span>${g.label}</span></span>`;
      btn.addEventListener('click', () => selectGroup(g.key));
      nav.appendChild(btn);
    }
  }
}

// ---------- Rendering: status banner ----------
function renderStatus(status) {
  const el = document.getElementById('statusBanner');
  document.getElementById('clearDraftedBtn').hidden = status.source !== 'upload';
  if (status.source === 'upload') {
    const problems = [];
    if (status.unmatched?.length) problems.push(`<br><b>${status.unmatched.length} unmatched:</b> ${status.unmatched.join(', ')}`);
    if (status.ambiguous?.length) problems.push(`<br><b>${status.ambiguous.length} ambiguous (same name twice):</b> ${status.ambiguous.join(', ')}`);
    el.className = 'status-banner' + (problems.length ? ' stale' : '');
    el.innerHTML = `<b>${status.drafted} drafted</b> from uploaded list${status.uploadFilename ? ' <i>' + status.uploadFilename + '</i>' : ''}.<br>Uploaded ${new Date(status.csvMtime).toLocaleString()}. Upload again any time to replace it.${problems.join('')}`;
    return;
  }
  if (!status.csvAvailable) {
    el.className = 'status-banner stale';
    el.innerHTML = `<b>Live draft CSV not found.</b><br>Expected at DraftOrder.csv in the UtilitySuite folder.`;
    return;
  }
  const pct = status.total ? Math.round(100 * status.matched / status.total) : 0;
  if (status.stale) {
    el.className = 'status-banner stale';
    el.innerHTML = `<b>Drafted-pick tracking inactive.</b><br>DraftOrder.csv matched only ${status.matched}/${status.total} current prospects (${pct}%) — it looks like an export from an earlier draft cycle. Re-export it from DraftAnalyzer during the live draft to enable pick tracking.`;
  } else {
    el.className = 'status-banner';
    el.innerHTML = `<b>${status.drafted} picks made</b> this cycle.<br>Live source matched ${pct}% of prospects. Updated ${new Date(status.csvMtime).toLocaleString()}.`;
  }
}

// ---------- Rendering: table ----------
function getFilteredSorted() {
  const q = state.search.trim().toLowerCase();
  const isPriority = state.currentKey === PRIORITY_KEY;
  let rows = state.players.filter(r => {
    if (state.currentKey === DRAFTED_KEY) { if (state.draftTeam && r.draftedTeam !== state.draftTeam) return false; }
    else if (state.hideDrafted && r.draftStatus?.drafted) return false;
    if (state.favoritesOnly && !r.favorite) return false;
    if (q && !(r.player.toLowerCase().includes(q) || (r.college || '').toLowerCase().includes(q))) return false;
    if (isPriority && state.priorityPositionExcluded.has(r.positionGroup)) return false;
    return true;
  });

  if (isPriority) {
    // Priority list order is manually curated (drag up/down) OR bulk-sorted by clicking a column
    // header (see sortPriority()) — either way state.players is already in the order to show;
    // this function only filters, it never re-sorts on its own.
    rows.forEach((r, i) => { r.__rank = i + 1; });
    return rows;
  }

  const colSet = getColumns();
  const sortCol = colSet.find(c => c.key === state.sortKey) || colSet.find(c => c.key === 'rating');
  rows.sort((a, b) => {
    const av = sortCol.val(a);
    const bv = sortCol.val(b);
    if (av == null && bv == null) return a.player.localeCompare(b.player);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return state.sortDir * av.localeCompare(bv);
    return (av - bv) * state.sortDir;
  });
  rows.forEach((r, i) => { r.__rank = i + 1; });
  return rows;
}

function renderTable() {
  const head = document.getElementById('boardHead');
  const body = document.getElementById('boardBody');
  const isPriority = state.currentKey === PRIORITY_KEY;
  const columns = getColumns();

  head.innerHTML = '<tr>' + columns.map(c => {
    if (c.key === '__controls') return `<th></th>`;
    const sorted = c.key === state.sortKey;
    const arrow = sorted ? (state.sortDir === -1 ? '↓' : '↑') : '';
    return `<th data-key="${c.key}" class="${sorted ? 'sorted' : ''}" title="${isPriority ? 'Click to bulk-sort the priority list by this column (overwrites manual order)' : ''}">${c.label}<span class="sort-arrow">${arrow}</span></th>`;
  }).join('') + '</tr>';
  head.querySelectorAll('th[data-key]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (isPriority) sortPriority(key);
      else {
        if (state.sortKey === key) state.sortDir *= -1;
        else { state.sortKey = key; state.sortDir = key === 'player' || key === 'college' || key === 'nativePosition' || key === 'ratedPosition' || key === 'draftedTeam' ? 1 : -1; }
        renderTable();
      }
    });
  });

  const rows = getFilteredSorted();
  document.getElementById('groupCount').textContent = `${rows.length} shown / ${state.players.length} total`;

  if (!rows.length) {
    const noneYet = state.currentKey === DRAFTED_KEY && !state.players.length;
    body.innerHTML = `<tr><td colspan="${columns.length}"><div class="empty-state">${noneYet ? 'No drafted players yet. Click <b>Upload Drafted</b> and choose your drafted-players file.' : 'No prospects match the current filters.'}</div></td></tr>`;
    return;
  }

  body.innerHTML = rows.map((r, i) => {
    const isResults = state.currentKey === DRAFTED_KEY;
    const draftedCls = (r.draftStatus?.drafted && !isResults ? ' drafted' : '') + (r.favorite ? ' favorite' : '');
    const cells = columns.map(c => {
      if (c.key === '__controls') {
        const isFirst = i === 0, isLast = i === rows.length - 1;
        return `<td class="priority-controls">
          <span class="drag-grip" title="Drag the row to reorder" aria-hidden="true">&#8942;&#8942;</span>
          <button class="pctl-btn" data-action="up" data-player-id="${r.playerId}" ${isFirst ? 'disabled' : ''} title="Move up" aria-label="Move up">&uarr;</button>
          <button class="pctl-btn" data-action="down" data-player-id="${r.playerId}" ${isLast ? 'disabled' : ''} title="Move down" aria-label="Move down">&darr;</button>
          <button class="pctl-btn pctl-remove" data-action="remove" data-player-id="${r.playerId}" title="Remove from list" aria-label="Remove from list">&times;</button>
        </td>`;
      }
      const raw = c.val(r);
      const display = c.format(raw);
      let content = display;
      if (c.key === 'player') {
        content = `${starButtonHtml(r)}<span class="cell-player">${display}</span>`;
        if (r.draftStatus?.drafted && !isResults) {
          content += ` <span class="chip chip-drafted" title="${r.draftStatus.team ? 'Drafted by ' + r.draftStatus.team : 'Drafted'}">Drafted${r.draftStatus.draftedOrder != null ? ' #' + r.draftStatus.draftedOrder : ''}</span>`;
        } else if (r.untested) {
          content += ` <span class="chip chip-excluded" title="No combine 40-time on file — DraftAnalyzer's degraded no-combine formula was used">Not combine-tested</span>`;
        }
        content += physicalThresholdChipHtml(r, true);
      } else if (c.key === 'ratedPosition') {
        const changed = r.ratedPosition !== r.nativePosition;
        content = `<span class="chip ${changed ? 'chip-tier-top' : 'chip-tier-sleeper'}">${display}</span>`;
      } else if (c.key === 'college') {
        content = `<span class="cell-college">${display || ''}</span>`;
      } else if (c.key === '__rank') {
        content = `<span class="rank-cell">${display}</span>`;
      } else if (c.key === 'rating') {
        content = `<strong>${display}</strong>`;
      }
      return `<td class="${c.num ? 'num' : ''}">${content}</td>`;
    }).join('');
    return `<tr class="${draftedCls}" data-player-id="${r.playerId}">${cells}</tr>`;
  }).join('');

  body.querySelectorAll('tr[data-player-id]').forEach(tr => {
    tr.addEventListener('click', () => openDrawer(Number(tr.dataset.playerId)));
  });
  wireStarButtons(body);

  if (isPriority) {
    wirePriorityDragAndDrop(body);
    body.querySelectorAll('.pctl-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const playerId = Number(btn.dataset.playerId);
        const action = btn.dataset.action;
        if (action === 'up') movePriorityPlayer(playerId, -1);
        else if (action === 'down') movePriorityPlayer(playerId, 1);
        else if (action === 'remove') removePriorityPlayer(playerId);
      });
    });
  }

  if (state.drawerPlayerId != null && !document.getElementById('drawer').hidden) updateDrawerNav();
}

// ---------- Shared: Elite Physical Threshold badge (table row + drawer) ----------
function physicalThresholdChipHtml(r, compact) {
  if (!r.physicalProfile?.applicable || r.physicalProfile.count === 0) return '';
  const pp = r.physicalProfile;
  const cls = pp.count === pp.total ? 'chip-phys-elite' : 'chip-phys-partial';
  const parts = [];
  if (pp.clears.dash) parts.push('Dash');
  if (pp.clears.broadJump) parts.push('Broad Jump');
  if (pp.clears.agility) parts.push('Agility');
  if (pp.clears.bench) parts.push('Bench');
  const title = 'Elite-athlete thresholds from FOF8 community research (not the Explosiveness score). Community 3-Cone benchmarks are applied to this dataset\'s Agility drill, the field that maps to 3-Cone/agility per that same research.' + (compact ? ` Clears: ${parts.join(', ')}.` : '');
  const label = compact ? `⚡ ${pp.count}/${pp.total}` : `⚡ ${pp.count}/${pp.total} Elite Thresholds: ${parts.join(', ')}`;
  return ` <span class="chip ${cls}" title="${title}">${label}</span>`;
}

// ---------- Drawer ----------
function ratingsTableHtml(allRatings, ratedPosition) {
  const rows = allRatings.map(r => `
    <tr class="${r.position === ratedPosition ? 'best' : ''}">
      <td>${r.position}</td>
      <td class="num">${r.combineScore.toFixed(1)}</td>
      <td class="num">${r.sizeScore.toFixed(1)}</td>
      <td class="num">${r.attributeScore.toFixed(1)}</td>
      <td class="num">${r.developmentScore.toFixed(1)}</td>
      <td class="num"><strong>${r.overallScore.toFixed(1)}</strong></td>
    </tr>`).join('');
  return `
  <table class="mini-table">
    <thead><tr><th>Pos</th><th class="num">Combine</th><th class="num">Size</th><th class="num">Attr</th><th class="num">Dev</th><th class="num">Overall</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function barRowHtml(b) {
  const cls = b.spotlight ? 'pbar pbar-spotlight' : 'pbar';
  const valsHtml = b.low === b.high
    ? `<span class="pbar-vals">${b.low}</span>`
    : `<span class="pbar-vals">${b.low} <span class="pbar-arrow">&rarr;</span> ${b.high}</span>`;
  return `
  <div class="${cls}">
    <div class="pbar-head"><span class="pbar-label">${b.label}</span>${valsHtml}</div>
    <div class="pbar-track">
      <div class="pbar-fill-ghost" style="width:${b.high}%"></div>
      <div class="pbar-fill" style="width:${b.low}%"></div>
    </div>
  </div>`;
}

function avoidInterceptionBarHtml(ai) {
  const lo = Math.max(0, Math.min(100, ai.low));
  const hi = Math.max(0, Math.min(100, ai.high));
  const exp = Math.max(0, Math.min(100, ai.expected));
  return `
  <div class="pbar pbar-estimated">
    <div class="pbar-head">
      <span class="pbar-label">Avoid Interception <span class="pbar-est-tag">Est.</span></span>
      <span class="pbar-vals">${exp.toFixed(0)} <span class="pbar-range-sub">(${lo.toFixed(0)}–${hi.toFixed(0)})</span></span>
    </div>
    <div class="pbar-track">
      <div class="pbar-range-band" style="left:${lo}%; width:${Math.max(0, hi - lo)}%"></div>
      <div class="pbar-tick-est" style="left:${exp}%"></div>
    </div>
  </div>`;
}

function traitAverages(attrBars) {
  if (!attrBars.length) return { current: 0, future: 0, gap: 0 };
  const current = attrBars.reduce((s, b) => s + b.low, 0) / attrBars.length;
  const future = attrBars.reduce((s, b) => s + b.high, 0) / attrBars.length;
  return { current, future, gap: future - current };
}

function explosivenessPanelHtml(r) {
  const ex = r.explosiveness;
  const traits = traitAverages(r.attrBars);
  const h = r.combineHighlights || { elite: 0, superior: 0, great: 0 };
  const highlightsStr = `${h.elite} Elite / ${h.superior} Superior / ${h.great} Great`;

  if (!ex) {
    return `
    <div class="fp-col-eyebrow">Explosiveness Profile</div>
    <div class="fp-ring-wrap fp-ring-empty">
      <div class="fp-ring-empty-label">Not combine-tested<br>— no drill numbers on file</div>
    </div>
    <div class="fp-explo-tiles">
      <div class="fp-tile"><div class="fp-tile-label">Current Trait Avg</div><div class="fp-tile-value">${fmt.f1(traits.current)}</div></div>
      <div class="fp-tile"><div class="fp-tile-label">Future Trait Avg</div><div class="fp-tile-value">${fmt.f1(traits.future)}</div></div>
      <div class="fp-tile"><div class="fp-tile-label">Development Gap</div><div class="fp-tile-value">+${fmt.f1(traits.gap)}</div></div>
      <div class="fp-tile"><div class="fp-tile-label">Combine Highlights</div><div class="fp-tile-value fp-tile-small">${highlightsStr}</div></div>
    </div>`;
  }

  const TIER_CLASS = { Elite: 'tier-elite', Good: 'tier-good', Average: 'tier-average', 'Below Average': 'tier-below', Poor: 'tier-poor' };
  const tierCls = TIER_CLASS[ex.tier] || 'tier-average';

  const componentTiles = [
    `<div class="fp-tile"><div class="fp-tile-label">Dash Score</div><div class="fp-tile-value">${ex.dashScore.toFixed(1)}</div></div>`,
    `<div class="fp-tile"><div class="fp-tile-label">Broad Jump Score</div><div class="fp-tile-value">${ex.broadJumpScore.toFixed(1)}</div></div>`,
    `<div class="fp-tile"><div class="fp-tile-label">Weight Score</div><div class="fp-tile-value">${ex.weightScore.toFixed(1)}</div></div>`,
  ];

  const ordinal = n => { const s = ['th', 'st', 'nd', 'rd'], v = Math.round(n) % 100; return (s[(v - 20) % 10] || s[v] || s[0]); };

  const rankOf = (label) => `<div class="fp-rank-note">#${ex.positionRank} of ${ex.groupSize} ${r.nativePosition}s${label ? ` ${label}` : ''}</div>`;

  return `
  <div class="fp-col-eyebrow">Explosiveness Profile</div>
  <div class="fp-ring-wrap">
    <div class="fp-ring ${tierCls}" style="--pct:${Math.max(0, Math.min(100, ex.percentile))}">
      <div class="fp-ring-inner">
        <div class="fp-ring-value">${ex.percentile.toFixed(1)}<span class="fp-ring-ord">${ordinal(ex.percentile)}</span></div>
        <div class="fp-ring-label">Position Percentile</div>
      </div>
    </div>
  </div>
  ${rankOf('by this class\'s percentile')}
  <div class="fp-raw-score-line">Raw Score <strong>${ex.score.toFixed(1)}</strong> <span class="chip ${tierCls === 'tier-elite' ? 'chip-phys-elite' : 'chip-tier-sleeper'}">${ex.tier}</span></div>
  ${rankOf('by raw score')}
  <div class="fp-explo-title">Size-Adjusted Explosiveness</div>
  <div class="fp-explo-desc">Forty, Broad Jump, and Weight, each measured (z-scored) against this player's position group, then averaged and converted to a 0-100 scale. The ring is this player's percentile among ${ex.groupSize} tested ${r.nativePosition} prospects in THIS class; the raw score above is a smooth, theoretical percentile independent of class strength — the two can disagree (high rank in a weak class, average raw score) and that's meaningful, not a bug.</div>
  <div class="fp-explo-tiles">
    ${componentTiles.join('')}
    <div class="fp-tile"><div class="fp-tile-label">Current Trait Avg</div><div class="fp-tile-value">${fmt.f1(traits.current)}</div></div>
    <div class="fp-tile"><div class="fp-tile-label">Future Trait Avg</div><div class="fp-tile-value">${fmt.f1(traits.future)}</div></div>
    <div class="fp-tile"><div class="fp-tile-label">Development Gap</div><div class="fp-tile-value">+${fmt.f1(traits.gap)}</div></div>
    <div class="fp-tile"><div class="fp-tile-label">Combine Highlights</div><div class="fp-tile-value fp-tile-small">${highlightsStr}</div></div>
  </div>`;
}

// Volatility (0-100, game-assigned): how likely a prospect is to suddenly jump or collapse in
// ability. Bands are descriptive only; the game does not publish official cutoffs.
function volatilityBand(v) {
  if (v == null) return { cls: '', label: 'n/a' };
  if (v >= 67) return { cls: 'fp-vol-high', label: 'High — boom/bust' };
  if (v >= 34) return { cls: '', label: 'Moderate' };
  return { cls: 'fp-vol-low', label: 'Low — predictable' };
}
function developmentStripHtml(r) {
  const band = volatilityBand(r.volatility);
  return `
  <div class="fp-devstrip">
    <div class="fp-dtile" title="How far along the prospect already is toward his ceiling. Feeds DraftAnalyzer's DevelopmentScore.">
      <div class="fp-mlabel">Developed %</div>
      <div class="fp-mvalue">${r.developed ?? '—'}</div>
    </div>
    <div class="fp-dtile" title="Likelihood of a sudden, drastic jump or drop in ability (0-100). Small-college and high-rated prospects skew higher.">
      <div class="fp-mlabel">Volatility</div>
      <div class="fp-mvalue ${band.cls}">${r.volatility ?? '—'}</div>
      <div class="fp-dnote ${band.cls}">${band.label}</div>
    </div>
  </div>`;
}

function openDrawer(playerId) {
  const r = state.players.find(p => p.playerId === playerId);
  if (!r) return;
  state.drawerPlayerId = playerId;
  const el = document.getElementById('drawerContent');

  let statusChips = '';
  if (r.draftStatus?.drafted) statusChips += `<span class="chip chip-drafted">Drafted${r.draftStatus.draftedOrder != null ? ' #' + r.draftStatus.draftedOrder : ''}</span>`;
  if (r.untested) statusChips += `<span class="chip chip-excluded">Not combine-tested</span>`;
  statusChips += physicalThresholdChipHtml(r, false);

  let html = `
  <div class="fp-eyebrow">Prospect Fingerprint</div>
  <div class="fp-title-row">
    <h2 class="fp-name">${starButtonHtml(r, 'star-lg')}${r.player}</h2>
    <div class="fp-rating"><div class="fp-rating-label">Rating</div><div class="fp-rating-value">${r.rating.toFixed(1)}</div></div>
  </div>
  <div class="fp-sub">${r.college || 'College unknown'} &middot; Native ${r.nativePosition}${r.ratedPosition !== r.nativePosition ? ` &middot; Rated ${r.ratedPosition}` : ''} ${statusChips}</div>

  ${(() => {
    const clears = r.physicalProfile?.applicable ? r.physicalProfile.clears : {};
    const goldCls = ok => ok ? ' fp-mvalue-gold' : '';
    // Poor/Average/Good/Great/Elite, z-scored vs this player's own position group — see
    // pools.js combineTier(). Average intentionally gets no class (stays the default text color).
    const tierCls = ch => {
      const t = r.combineTiers?.[ch];
      return t && t !== 'average' ? ` cscore-${t}` : '';
    };
    return `
  <div class="fp-measurables">
    <div class="fp-mtile"><div class="fp-mlabel">Height</div><div class="fp-mvalue">${fmt.height(r.height)}</div></div>
    <div class="fp-mtile"><div class="fp-mlabel">Weight</div><div class="fp-mvalue">${r.weight}</div></div>
    <div class="fp-mtile fp-mtile-accent" title="Elite threshold: sub-${r.physicalProfile?.thresholds ? (r.physicalProfile.thresholds.dash / 100).toFixed(2) : '?'}s"><div class="fp-mlabel">40 dash</div><div class="fp-mvalue${tierCls('dash')}${goldCls(clears.dash)}">${fmt.dash(r.dash)}</div></div>
    <div class="fp-mtile"><div class="fp-mlabel">Solecismic</div><div class="fp-mvalue${tierCls('solecismic')}">${r.combine.solecismic}</div></div>
    <div class="fp-mtile fp-mtile-accent" title="Elite threshold: ${r.physicalProfile?.thresholds ? r.physicalProfile.thresholds.bench : '?'}+ reps"><div class="fp-mlabel">Bench</div><div class="fp-mvalue${tierCls('bench')}${goldCls(clears.bench)}">${r.combine.bench}</div></div>
    <div class="fp-mtile fp-mtile-accent" title="Elite threshold: ${r.physicalProfile?.thresholds ? r.physicalProfile.thresholds.broadJump : '?'}in+"><div class="fp-mlabel">Broad jump</div><div class="fp-mvalue${tierCls('broadJump')}${goldCls(clears.broadJump)}">${r.combine.broadJump}</div></div>
    <div class="fp-mtile fp-mtile-accent" title="Elite threshold: sub-${r.physicalProfile?.thresholds ? (r.physicalProfile.thresholds.agility / 100).toFixed(2) : '?'}s"><div class="fp-mlabel">Agility</div><div class="fp-mvalue${tierCls('agility')}${goldCls(clears.agility)}">${fmt.agility(r.combine.agility)}</div></div>
  </div>`;
  })()}

  ${developmentStripHtml(r)}

  <div class="fp-grid">
    <div class="fp-col">
      <div class="fp-col-eyebrow">Scouting Profile</div>
      <div class="fp-col-title">Prospect Bars <span class="fp-col-hint">Current / Future</span></div>
      ${r.avoidInterception ? avoidInterceptionBarHtml(r.avoidInterception) : ''}
      ${r.attrBars.map(barRowHtml).join('')}
    </div>
    <div class="fp-col fp-col-explo">
      ${explosivenessPanelHtml(r)}
    </div>
  </div>

  <div class="section"><div class="section-label">Rated at every tested position — Combine / Size / Attribute / Development components sum to Overall, then multiplied by that position's weight to get Rating</div>${ratingsTableHtml(r.allRatings, r.ratedPosition)}</div>`;

  el.innerHTML = html;
  wireStarButtons(el);
  document.getElementById('drawer').hidden = false;
  document.getElementById('drawerBackdrop').hidden = false;
  document.getElementById('drawer').scrollTop = 0;
  updateDrawerNav();
}
function closeDrawer() {
  document.getElementById('drawer').hidden = true;
  document.getElementById('drawerBackdrop').hidden = true;
  state.drawerPlayerId = null;
}

// ---------- Drawer prev/next: cycles through the SAME filtered/sorted order shown in the table ----------
function updateDrawerNav() {
  const rows = getFilteredSorted();
  const idx = rows.findIndex(r => r.playerId === state.drawerPlayerId);
  const prevBtn = document.getElementById('drawerPrev');
  const nextBtn = document.getElementById('drawerNext');
  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx === -1 || idx >= rows.length - 1;
  prevBtn.title = idx > 0 ? rows[idx - 1].player : '';
  nextBtn.title = idx !== -1 && idx < rows.length - 1 ? rows[idx + 1].player : '';
}
function navigateDrawer(delta) {
  const rows = getFilteredSorted();
  const idx = rows.findIndex(r => r.playerId === state.drawerPlayerId);
  if (idx === -1) return;
  const next = rows[idx + delta];
  if (next) openDrawer(next.playerId);
}

// ---------- Group selection ----------
async function selectGroup(key) {
  state.currentKey = key;
  state.sortKey = key === DRAFTED_KEY ? 'pick' : 'rating';
  state.sortDir = key === DRAFTED_KEY ? 1 : -1;
  renderNav();
  const g = state.groups.find(x => x.key === key);
  document.getElementById('groupLabel').textContent = g.label;
  document.getElementById('modelNote').hidden = true;
  document.getElementById('resetListBtn').hidden = key !== PRIORITY_KEY;
  document.getElementById('exportListBtn').hidden = key !== PRIORITY_KEY;
  document.getElementById('positionFilterWrap').hidden = key !== PRIORITY_KEY;
  document.getElementById('positionFilterPanel').hidden = true;
  document.getElementById('teamFilter').hidden = key !== DRAFTED_KEY;
  document.getElementById('hideDraftedWrap').hidden = key === DRAFTED_KEY;
  if (key === PRIORITY_KEY) state.priorityPositionExcluded = new Set();

  document.getElementById('boardBody').innerHTML = `<tr><td colspan="${getColumns().length}"><div class="empty-state">Loading…</div></td></tr>`;
  try {
    await fetchBoard(key);
  } catch (e) {
    document.getElementById('boardBody').innerHTML = `<tr><td colspan="${getColumns().length}">
      <div class="empty-state empty-state-error">
        <div>Couldn't load ${g.label} — ${e.message}</div>
        <div class="empty-state-hint">Is the server still running? (<code>node server.js</code>)</div>
        <button class="btn-refresh" id="boardRetryBtn">⟳ Try again</button>
      </div>
    </td></tr>`;
    document.getElementById('boardRetryBtn').addEventListener('click', () => selectGroup(key));
    return;
  }
  if (key === PRIORITY_KEY) renderPositionFilterPanel();
  renderTable();
}

// ---------- Init ----------
function wireControls() {
  document.getElementById('search').addEventListener('input', e => { state.search = e.target.value; renderTable(); });
  document.getElementById('hideDrafted').addEventListener('change', e => { state.hideDrafted = e.target.checked; renderTable(); });
  document.getElementById('favoritesOnly').addEventListener('change', e => { state.favoritesOnly = e.target.checked; renderTable(); });
  document.getElementById('teamFilter').addEventListener('change', e => { state.draftTeam = e.target.value; renderTable(); });
  document.getElementById('drawerClose').addEventListener('click', closeDrawer);
  document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);
  document.getElementById('drawerPrev').addEventListener('click', () => navigateDrawer(-1));
  document.getElementById('drawerNext').addEventListener('click', () => navigateDrawer(1));
  document.addEventListener('keydown', e => {
    if (document.getElementById('drawer').hidden) return;
    if (e.key === 'ArrowLeft') navigateDrawer(-1);
    else if (e.key === 'ArrowRight') navigateDrawer(1);
    else if (e.key === 'Escape') closeDrawer();
  });
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning'); btn.textContent = '⟳ Refreshing…';
    try {
      await Promise.all([fetchBoard(state.currentKey), fetchStatus().then(renderStatus)]);
      if (state.currentKey === PRIORITY_KEY) renderPositionFilterPanel();
      renderTable();
    } catch (e) {
      alert(`Refresh failed: ${e.message}\n\nIs the server still running? (node server.js)`);
    }
    btn.classList.remove('spinning'); btn.textContent = '⟳ Refresh';
  });
  document.getElementById('uploadDraftedBtn').addEventListener('click', () => document.getElementById('draftedFile').click());
  document.getElementById('draftedFile').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const btn = document.getElementById('uploadDraftedBtn');
    btn.disabled = true; btn.textContent = '⇧ Uploading…';
    try {
      const text = await file.text();
      const res = await fetch('/api/drafted/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, filename: file.name }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error + (data.unmatched?.length ? '\n\nUnmatched: ' + data.unmatched.slice(0, 20).join(', ') : ''));
      await Promise.all([fetchBoard(state.currentKey), fetchStatus().then(renderStatus)]);
      renderTable();
      let msg = `${data.drafted} players marked Drafted from ${data.rows} rows in ${file.name}.`;
      if (data.unmatched.length) msg += `\n\n${data.unmatched.length} not matched to any current prospect:\n${data.unmatched.join('\n')}`;
      if (data.ambiguous.length) msg += `\n\n${data.ambiguous.length} ambiguous (two prospects share the name; add a Birthdate column to resolve):\n${data.ambiguous.join('\n')}`;
      alert(msg);
    } catch (err) {
      alert(`Upload failed: ${err.message}`);
    }
    btn.disabled = false; btn.textContent = '⇧ Upload Drafted';
  });
  document.getElementById('clearDraftedBtn').addEventListener('click', async () => {
    if (!confirm('Clear the uploaded drafted list? The board will fall back to the UtilitySuite DraftOrder.csv.')) return;
    await fetch('/api/drafted/clear', { method: 'POST' });
    await Promise.all([fetchBoard(state.currentKey), fetchStatus().then(renderStatus)]);
    renderTable();
  });
  document.getElementById('resetListBtn').addEventListener('click', resetPriorityList);
  document.getElementById('exportListBtn').addEventListener('click', exportPriorityList);

  document.getElementById('positionFilterBtn').addEventListener('click', () => {
    const panel = document.getElementById('positionFilterPanel');
    panel.hidden = !panel.hidden;
  });
  document.getElementById('positionFilterAll').addEventListener('click', () => {
    state.priorityPositionExcluded.clear();
    renderPositionFilterPanel();
    renderTable();
  });
  document.getElementById('positionFilterNone').addEventListener('click', () => {
    priorityPositionGroups().forEach(g => state.priorityPositionExcluded.add(g));
    renderPositionFilterPanel();
    renderTable();
  });
  document.addEventListener('click', e => {
    const wrap = document.getElementById('positionFilterWrap');
    if (!wrap.hidden && !wrap.contains(e.target)) document.getElementById('positionFilterPanel').hidden = true;
  });
}

async function init() {
  wireControls();
  await fetchGroups();
  renderNav();
  fetchStatus().then(renderStatus);
  await selectGroup(state.groups[0].key);
}
init();
