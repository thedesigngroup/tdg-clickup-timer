// TDG Timer — renderer (UI) for the app window. Talks to ClickUp only through window.tdg.api,
// which the main process proxies. Nothing here is hard-coded to particular
// Spaces or Lists: the whole hierarchy is read live from ClickUp.

const $ = (id) => document.getElementById(id);
// window.tdg is provided by preload.js (exposed as the global `tdg`).

const state = {
  settings: {},
  user: null,
  teams: [],
  teamId: null,
  spaces: {},          // id -> name
  tasks: [],           // compact task objects
  taskById: new Map(),
  tasksLoadedAt: 0,
  current: null,       // running time entry
  scope: 'mine',
  space: '',
  query: '',
  selected: 0,
  rows: [],            // tasks currently rendered, in order
  manualTask: null,
  idle: null,
  update: null,
};

// ---------------- helpers ----------------
async function api(method, path, body) {
  const r = await tdg.api(method, path, body);
  if (!r.ok) {
    const e = new Error(r.error || 'Request failed');
    e.status = r.status;
    throw e;
  }
  return r.data;
}

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg || '';
  el.style.color = isError ? 'var(--stop)' : '';
  el.title = msg || '';
}

function fmtClock(ms, withSeconds = true) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return withSeconds
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${h}:${String(m).padStart(2, '0')}`;
}

function fmtMinutes(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// "1h 15m", "1h15", "1:15", "45m", "45", "1.5h", "2h"  ->  milliseconds
function parseDuration(text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return 0;
  let m;
  if ((m = t.match(/^(\d+):(\d{1,2})$/))) return (+m[1] * 60 + +m[2]) * 60000;
  if ((m = t.match(/^(\d+(?:\.\d+)?)h(?:(\d+)m?)?$/))) return Math.round((+m[1] * 60 + (+m[2] || 0)) * 60000);
  if ((m = t.match(/^(\d+)m(?:in)?s?$/))) return +m[1] * 60000;
  if ((m = t.match(/^(\d+(?:\.\d+)?)$/))) return Math.round(+m[1] * 60000); // bare number = minutes
  return 0;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function taskPath(t) {
  if (!t) return '';
  const parts = [state.spaces[t.spaceId], t.folder, t.list].filter(Boolean);
  return parts.join(' › ');
}

function cache(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
}

// ---------------- views ----------------
function show(view) {
  for (const v of ['viewMain', 'viewManual', 'viewIdle', 'viewSettings']) $(v).classList.toggle('hidden', v !== view);
  if (view === 'viewMain') setTimeout(() => $('search').focus(), 10);
}

// ---------------- connect / load ----------------
async function connect() {
  setStatus('Connecting…');
  const [{ user }, { teams }] = await Promise.all([api('GET', '/user'), api('GET', '/team')]);
  state.user = user;
  state.teams = teams || [];
  if (!state.teams.length) throw new Error('No ClickUp workspaces found for this token');
  const saved = state.settings.teamId && state.teams.find((t) => String(t.id) === String(state.settings.teamId));
  state.teamId = String((saved || state.teams[0]).id);

  const cached = cache(`tasks:${state.teamId}`);
  if (cached && cached.tasks) {
    state.spaces = cached.spaces || {};
    setTasks(cached.tasks);
    render();
  }
  await Promise.all([loadSpaces(), refreshCurrent()]);
  await loadTasks();
}

async function loadSpaces() {
  const { spaces } = await api('GET', `/team/${state.teamId}/space?archived=false`);
  state.spaces = {};
  for (const s of spaces || []) state.spaces[s.id] = s.name;
  const sel = $('spaceFilter');
  const keep = state.space;
  sel.innerHTML = '<option value="">All spaces</option>' +
    Object.entries(state.spaces).sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
  sel.value = state.spaces[keep] ? keep : '';
  state.space = sel.value;
}

function compact(t) {
  return {
    id: t.id,
    name: t.name,
    url: t.url,
    status: t.status ? t.status.status : '',
    color: t.status ? t.status.color : '',
    list: t.list ? t.list.name : '',
    listId: t.list ? t.list.id : '',
    folder: t.folder && !t.folder.hidden ? t.folder.name : '',
    spaceId: t.space ? t.space.id : '',
    assignees: (t.assignees || []).map((a) => a.id),
    updated: +t.date_updated || 0,
  };
}

function setTasks(list) {
  state.tasks = list;
  state.taskById = new Map(list.map((t) => [t.id, t]));
}

let loadingTasks = false;
async function loadTasks() {
  if (loadingTasks) return;
  loadingTasks = true;
  setStatus('Loading tasks…');
  try {
    const all = [];
    // Open tasks across the whole workspace, newest activity first.
    for (let page = 0; page < 60; page++) {
      const data = await api('GET', `/team/${state.teamId}/task?page=${page}&subtasks=true&include_closed=false&order_by=updated`);
      const batch = data.tasks || [];
      all.push(...batch.map(compact));
      if (data.last_page || batch.length === 0) break;
    }
    // Keep tasks referenced by recents/favorites/current even if now closed.
    for (const id of [...(state.settings.recents || []), ...(state.settings.favorites || [])]) {
      if (!all.find((t) => t.id === id) && state.taskById.has(id)) all.push(state.taskById.get(id));
    }
    setTasks(all);
    state.tasksLoadedAt = Date.now();
    cache(`tasks:${state.teamId}`, { tasks: all, spaces: state.spaces });
    setStatus(`${all.length} tasks`);
    render();
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    loadingTasks = false;
  }
}

// ---------------- current timer ----------------
async function refreshCurrent() {
  try {
    const { data } = await api('GET', `/team/${state.teamId}/time_entries/current`);
    state.current = data && data.id ? data : null;
  } catch (e) {
    setStatus(e.message, true);
  }
  renderCurrent();
}

function currentTask() {
  if (!state.current || !state.current.task) return null;
  const t = state.current.task;
  return state.taskById.get(t.id) || { id: t.id, name: t.name, list: '', spaceId: '' };
}

function renderCurrent() {
  const c = state.current;
  const card = $('current');
  card.classList.toggle('running', !!c);
  card.classList.toggle('idle', !c);
  $('stopBtn').classList.toggle('hidden', !c);
  $('curNote').classList.toggle('hidden', !c);
  if (c) {
    const t = currentTask();
    $('curName').textContent = t ? t.name : (c.description || 'Timer running (no task)');
    $('curPath').textContent = t ? taskPath(t) : '';
    if (document.activeElement !== $('curNote')) $('curNote').value = c.description || '';
  } else {
    $('curName').textContent = 'Not tracking';
    $('curPath').textContent = 'Pick a task below to start';
  }
  tdg.setRunning(!!c);
  tick();
  render();
}

function tick() {
  const c = state.current;
  if (!c) {
    $('curTime').textContent = '0:00:00';
    tdg.setTrayTitle('');
    return;
  }
  const elapsed = Date.now() - Number(c.start);
  $('curTime').textContent = fmtClock(elapsed);
  tdg.setTrayTitle(fmtClock(elapsed, false));
}

async function startTask(task) {
  if (!task) return;
  if (state.current && state.current.task && state.current.task.id === task.id) return;
  setStatus('Starting…');
  try {
    if (state.current) await api('POST', `/team/${state.teamId}/time_entries/stop`);
    const { data } = await api('POST', `/team/${state.teamId}/time_entries/start`, {
      tid: task.id,
      billable: !!state.settings.defaultBillable,
    });
    state.current = data;
    pushRecent(task.id);
    setStatus(`Tracking: ${task.name}`);
  } catch (e) {
    setStatus(e.message, true);
    await refreshCurrent();
    return;
  }
  renderCurrent();
}

async function stopTimer() {
  if (!state.current) return;
  setStatus('Stopping…');
  try {
    await api('POST', `/team/${state.teamId}/time_entries/stop`);
    const t = currentTask();
    state.current = null;
    setStatus(t ? `Saved time on ${t.name}` : 'Stopped');
  } catch (e) {
    setStatus(e.message, true);
  }
  renderCurrent();
}

async function saveNote() {
  const c = state.current;
  if (!c) return;
  const note = $('curNote').value.trim();
  if (note === (c.description || '')) return;
  try {
    await api('PUT', `/team/${state.teamId}/time_entries/${c.id}`, { description: note, tid: c.task ? c.task.id : undefined });
    c.description = note;
    setStatus('Note saved');
  } catch (e) {
    setStatus(e.message, true);
  }
}

function pushRecent(id) {
  const r = [id, ...(state.settings.recents || []).filter((x) => x !== id)].slice(0, 10);
  state.settings.recents = r;
  tdg.setSettings({ recents: r });
}

function toggleFavorite(id) {
  const f = state.settings.favorites || [];
  const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id];
  state.settings.favorites = next;
  tdg.setSettings({ favorites: next });
  render();
}

// ---------------- search + list ----------------
function search(query, { scope = state.scope, space = state.space, limit = 80 } = {}) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const me = state.user && state.user.id;
  const out = [];
  for (const t of state.tasks) {
    if (space && String(t.spaceId) !== String(space)) continue;
    if (scope === 'mine' && me && !t.assignees.includes(me)) continue;
    const name = t.name.toLowerCase();
    const hay = `${name} ${(state.spaces[t.spaceId] || '').toLowerCase()} ${t.folder.toLowerCase()} ${t.list.toLowerCase()} ${t.id}`;
    if (!words.every((w) => hay.includes(w))) continue;
    let score = 0;
    if (words.length) {
      if (name.startsWith(words[0])) score += 3;
      if (words.every((w) => name.includes(w))) score += 2;
    }
    out.push({ t, score });
  }
  out.sort((a, b) => b.score - a.score || b.t.updated - a.t.updated);
  return out.slice(0, limit).map((x) => x.t);
}

function render() {
  const list = $('list');
  const q = state.query.trim();
  const groups = [];
  const runningId = state.current && state.current.task ? state.current.task.id : null;
  const inScope = (t) => !state.space || String(t.spaceId) === String(state.space);

  if (!state.settings.token) {
    list.innerHTML = '<div class="empty">Add your ClickUp token in Settings to begin.</div>';
    state.rows = [];
    return;
  }

  if (q) {
    let rows = search(q);
    groups.push({ title: rows.length ? null : '', rows });
    if (!rows.length && state.scope === 'mine') {
      const others = search(q, { scope: 'all' });
      if (others.length) groups.push({ title: 'Not assigned to you', rows: others });
    }
  } else {
    const favs = (state.settings.favorites || []).map((id) => state.taskById.get(id)).filter(Boolean).filter(inScope);
    const recents = (state.settings.recents || []).map((id) => state.taskById.get(id)).filter(Boolean)
      .filter(inScope).filter((t) => !favs.includes(t)).slice(0, 6);
    const shown = new Set([...favs, ...recents]);
    const rest = search('', { limit: 60 }).filter((t) => !shown.has(t));
    if (favs.length) groups.push({ title: 'Favorites', rows: favs });
    if (recents.length) groups.push({ title: 'Recent', rows: recents });
    groups.push({ title: state.scope === 'mine' ? 'Assigned to me' : 'Recently updated', rows: rest });
  }

  state.rows = groups.flatMap((g) => g.rows);
  if (state.selected >= state.rows.length) state.selected = Math.max(0, state.rows.length - 1);

  if (!state.rows.length) {
    list.innerHTML = `<div class="empty">${state.tasks.length ? 'No matching tasks.' + (state.scope === 'mine' ? ' Try “All”.' : '') : 'Loading tasks…'}</div>`;
    return;
  }

  const favSet = new Set(state.settings.favorites || []);
  let i = 0;
  list.innerHTML = groups.filter((g) => g.rows.length).map((g) =>
    (g.title ? `<div class="group">${esc(g.title)}</div>` : '') +
    g.rows.map((t) => {
      const idx = i++;
      const running = t.id === runningId;
      return `<div class="task${idx === state.selected ? ' selected' : ''}${running ? ' running' : ''}" data-idx="${idx}" title="${esc(t.name)}">
        <span class="dot" style="background:${esc(t.color || '#bbb')}"></span>
        <div class="t-main">
          <div class="t-name">${esc(t.name)}</div>
          <div class="t-path">${esc(taskPath(t))}${t.status ? ' · ' + esc(t.status) : ''}</div>
        </div>
        <div class="t-actions">
          <button class="t-act fav${favSet.has(t.id) ? ' on' : ''}" data-act="fav" title="Favorite">★</button>
          <button class="t-act" data-act="add" title="Add time manually">＋</button>
          <button class="t-act" data-act="open" title="Open in ClickUp">↗</button>
          <button class="t-act" data-act="${running ? 'stop' : 'start'}" title="${running ? 'Stop' : 'Start timer'}">${running ? '■' : '▶'}</button>
        </div>
      </div>`;
    }).join('')
  ).join('');
}

function moveSelection(delta) {
  if (!state.rows.length) return;
  state.selected = (state.selected + delta + state.rows.length) % state.rows.length;
  render();
  const el = document.querySelector('.task.selected');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

// ---------------- manual entry ----------------
function openManual(task) {
  state.manualTask = task || null;
  const now = new Date();
  $('mDate').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  $('mStart').value = '';
  $('mDuration').value = '';
  $('mNote').value = '';
  $('mBillable').checked = !!state.settings.defaultBillable;
  $('mError').classList.add('hidden');
  $('mDurationHint').textContent = '';
  renderManualTask();
  show('viewManual');
  setTimeout(() => (task ? $('mDuration') : $('mTaskSearch')).focus(), 10);
}

function renderManualTask() {
  const t = state.manualTask;
  $('mTaskSearch').classList.toggle('hidden', !!t);
  $('mTaskPick').classList.add('hidden');
  $('mTaskChosen').classList.toggle('hidden', !t);
  if (t) $('mTaskChosen').innerHTML = `<span>${esc(t.name)}<br><small style="color:var(--muted);font-weight:400">${esc(taskPath(t))}</small></span><button type="button" id="mClear" title="Change task">✕</button>`;
}

function manualStart(dateStr, timeStr, durMs) {
  // Start time given -> use it. Otherwise: today ends "now"; past days start at 9:00.
  const [y, mo, d] = dateStr.split('-').map(Number);
  if (timeStr) {
    const [h, mi] = timeStr.split(':').map(Number);
    return new Date(y, mo - 1, d, h, mi).getTime();
  }
  const today = new Date();
  const isToday = today.getFullYear() === y && today.getMonth() === mo - 1 && today.getDate() === d;
  return isToday ? Date.now() - durMs : new Date(y, mo - 1, d, 9, 0).getTime();
}

async function submitManual(e) {
  e.preventDefault();
  const err = $('mError');
  err.classList.add('hidden');
  const dur = parseDuration($('mDuration').value);
  if (!state.manualTask) { err.textContent = 'Pick a task.'; err.classList.remove('hidden'); return; }
  if (!dur) { err.textContent = 'Enter a duration like 1h 15m, 1:15 or 45m.'; err.classList.remove('hidden'); return; }
  const start = manualStart($('mDate').value, $('mStart').value, dur);
  try {
    await api('POST', `/team/${state.teamId}/time_entries`, {
      tid: state.manualTask.id,
      start,
      duration: dur,
      description: $('mNote').value.trim() || undefined,
      billable: $('mBillable').checked,
    });
    pushRecent(state.manualTask.id);
    setStatus(`Added ${fmtMinutes(dur)} to ${state.manualTask.name}`);
    show('viewMain');
    render();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
}

// ---------------- idle ----------------
function onIdleReturned({ idleSince, now }) {
  if (!state.current) return;
  state.idle = { idleSince, now };
  const since = new Date(idleSince).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('idleText').textContent = `You were away for ${fmtMinutes(now - idleSince)} (since ${since}) while tracking “${(currentTask() || {}).name || 'a task'}”.`;
  show('viewIdle');
}

async function trimIdle(keepGoing) {
  const c = state.current;
  const idle = state.idle;
  state.idle = null;
  if (!c || !idle) { show('viewMain'); return; }
  const task = currentTask();
  try {
    await api('POST', `/team/${state.teamId}/time_entries/stop`);
    const start = Number(c.start);
    const end = Math.max(start + 1000, idle.idleSince);
    await api('PUT', `/team/${state.teamId}/time_entries/${c.id}`, {
      start, end, duration: end - start, tid: task ? task.id : undefined,
    });
    state.current = null;
    setStatus(`Removed ${fmtMinutes(Date.now() - idle.idleSince)} of idle time`);
    if (keepGoing && task) await startTask(task);
  } catch (e) {
    setStatus(e.message, true);
  }
  await refreshCurrent();
  show('viewMain');
}

// ---------------- settings ----------------
function openSettings(first) {
  const s = state.settings;
  $('welcome').classList.toggle('hidden', !first);
  $('settingsBack').classList.toggle('hidden', !!first);
  $('sToken').value = s.token || '';
  $('sIdle').value = String(s.idleMinutes ?? 10);
  $('sBillable').checked = !!s.defaultBillable;
  $('sLogin').checked = s.launchAtLogin !== false;
  $('sVersion').textContent = `Version ${s.version || ''}`;
  $('sError').classList.add('hidden');
  const wrap = $('sTeamWrap');
  wrap.classList.toggle('hidden', state.teams.length < 2);
  $('sTeam').innerHTML = state.teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  if (state.teamId) $('sTeam').value = state.teamId;
  show('viewSettings');
  if (first) setTimeout(() => $('sToken').focus(), 10);
}

async function saveSettingsForm(e) {
  e.preventDefault();
  const token = $('sToken').value.trim();
  const err = $('sError');
  err.classList.add('hidden');
  if (!token) { err.textContent = 'Paste your ClickUp API token.'; err.classList.remove('hidden'); return; }
  const tokenChanged = token !== state.settings.token;
  const teamChanged = !$('sTeamWrap').classList.contains('hidden') && $('sTeam').value !== state.teamId;
  state.settings = await tdg.setSettings({
    token,
    idleMinutes: Number($('sIdle').value),
    defaultBillable: $('sBillable').checked,
    launchAtLogin: $('sLogin').checked,
    ...(teamChanged ? { teamId: $('sTeam').value } : {}),
  });
  if (tokenChanged || teamChanged) {
    try {
      // New token = possibly different workspaces, so forget the saved one.
      state.settings = await tdg.setSettings({ teamId: teamChanged ? $('sTeam').value : null });
      setTasks([]);
      show('viewMain');
      render();
      await connect();
    } catch (ex) {
      openSettings(!state.user);
      err.textContent = ex.status === 401 ? 'ClickUp didn’t accept that token. Check it and try again.' : ex.message;
      err.classList.remove('hidden');
      return;
    }
  }
  show('viewMain');
  render();
}

// ---------------- updates ----------------
async function checkForUpdate(manual) {
  const r = await tdg.checkUpdate();
  state.update = r && r.available ? r : null;
  $('update').classList.toggle('hidden', !state.update);
  if (state.update) $('updateText').textContent = `Update ${state.update.version} available`;
  if (manual) setStatus(state.update ? `Update ${state.update.version} available` : (r.reason ? `Update check: ${r.reason}` : 'You’re up to date'));
}

async function installUpdate() {
  if (!state.update) return;
  $('updateBtn').disabled = true;
  $('updateText').textContent = 'Downloading update…';
  const r = await tdg.installUpdate(state.update);
  if (!r.ok) {
    $('updateBtn').disabled = false;
    $('updateText').textContent = `Update failed: ${r.error}`;
  }
}

// ---------------- events ----------------
function wire() {
  $('search').addEventListener('input', (e) => { state.query = e.target.value; state.selected = 0; render(); });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); startTask(state.rows[state.selected]); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('viewMain').classList.contains('hidden')) {
        if (state.query) { state.query = ''; $('search').value = ''; render(); }
      } else if ($('viewIdle').classList.contains('hidden') && state.settings.token) show('viewMain');
    }
    if (e.metaKey && e.key === ',') openSettings(false);
    if (e.metaKey && e.key === 'n') openManual(state.rows[state.selected]);
  });

  document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
    state.scope = b.dataset.scope;
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    state.selected = 0;
    render();
  }));
  $('spaceFilter').addEventListener('change', (e) => { state.space = e.target.value; state.selected = 0; render(); });

  $('list').addEventListener('click', (e) => {
    const row = e.target.closest('.task');
    if (!row) return;
    const t = state.rows[Number(row.dataset.idx)];
    const act = e.target.closest('[data-act]');
    const a = act ? act.dataset.act : 'start';
    if (a === 'fav') toggleFavorite(t.id);
    else if (a === 'add') openManual(t);
    else if (a === 'open') tdg.openUrl(t.url);
    else if (a === 'stop') stopTimer();
    else startTask(t);
  });

  $('stopBtn').addEventListener('click', stopTimer);
  $('curNote').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('curNote').addEventListener('blur', saveNote);
  $('refreshBtn').addEventListener('click', async () => { await loadSpaces().catch(() => {}); await refreshCurrent(); await loadTasks(); });
  $('settingsBtn').addEventListener('click', () => openSettings(false));
  $('manualBtn').addEventListener('click', () => openManual(currentTask()));
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => show('viewMain')));

  // manual entry form
  $('manualForm').addEventListener('submit', submitManual);
  $('mDuration').addEventListener('input', (e) => {
    const ms = parseDuration(e.target.value);
    $('mDurationHint').textContent = e.target.value ? (ms ? `= ${fmtMinutes(ms)}` : 'Try 1h 15m, 1:15, 45m or 1.5h') : '';
  });
  $('mTaskSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    const pick = $('mTaskPick');
    if (!q) { pick.classList.add('hidden'); return; }
    const rows = search(q, { scope: 'all', space: '', limit: 25 });
    pick.innerHTML = rows.length ? rows.map((t) => `<div class="task" data-id="${esc(t.id)}"><span class="dot" style="background:${esc(t.color || '#bbb')}"></span><div class="t-main"><div class="t-name">${esc(t.name)}</div><div class="t-path">${esc(taskPath(t))}</div></div></div>`).join('') : '<div class="empty">No matches</div>';
    pick.classList.remove('hidden');
  });
  $('mTaskPick').addEventListener('click', (e) => {
    const row = e.target.closest('.task');
    if (!row) return;
    state.manualTask = state.taskById.get(row.dataset.id);
    $('mTaskSearch').value = '';
    renderManualTask();
    $('mDuration').focus();
  });
  $('mTaskChosen').addEventListener('click', (e) => {
    if (e.target.id !== 'mClear') return;
    state.manualTask = null;
    renderManualTask();
    $('mTaskSearch').focus();
  });

  // idle
  $('idleKeep').addEventListener('click', () => { state.idle = null; show('viewMain'); });
  $('idleTrimContinue').addEventListener('click', () => trimIdle(true));
  $('idleTrimStop').addEventListener('click', () => trimIdle(false));

  // settings
  $('settingsForm').addEventListener('submit', saveSettingsForm);
  $('tokenHelp').addEventListener('click', (e) => { e.preventDefault(); tdg.openUrl('https://app.clickup.com/settings/apps'); });
  $('sQuit').addEventListener('click', () => tdg.quit());
  $('sCheckUpdate').addEventListener('click', () => checkForUpdate(true));
  $('updateBtn').addEventListener('click', installUpdate);

  tdg.on('window-shown', () => {
    if (!$('viewMain').classList.contains('hidden')) { $('search').select(); $('search').focus(); }
    if (state.teamId) {
      refreshCurrent();
      if (Date.now() - state.tasksLoadedAt > 3 * 60 * 1000) loadTasks();
    }
  });
  tdg.on('idle-returned', onIdleReturned);
}

// ---------------- boot ----------------
async function boot() {
  wire();
  state.settings = await tdg.getSettings();
  setInterval(tick, 1000);
  // Stay in sync with timers started/stopped in ClickUp itself.
  setInterval(() => { if (state.teamId) refreshCurrent(); }, 30 * 1000);
  setInterval(() => { if (state.teamId) loadTasks(); }, 10 * 60 * 1000);
  checkForUpdate(false);
  setInterval(() => checkForUpdate(false), 6 * 60 * 60 * 1000);

  if (!state.settings.token) { openSettings(true); return; }
  show('viewMain');
  try {
    await connect();
  } catch (e) {
    if (e.status === 401) { openSettings(true); $('sError').textContent = 'Your ClickUp token no longer works. Paste a new one.'; $('sError').classList.remove('hidden'); }
    else setStatus(e.message, true);
  }
}

// Exposed for tests.
window.__tdgTest = { parseDuration, manualStart, search, state };
boot();
