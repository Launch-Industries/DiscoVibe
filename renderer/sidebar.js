'use strict';
// ===========================================================================
// Sidebar: what needs you, what is running, and what is unfinished.
//
// Loaded after renderer.js and shares its globals (panes, stored, focusedId,
// addPane, restorePane, setFocused, runResume, fmtWhen, lic, renderIcons...).
//
// Every window reports its own panes to main a few times a second when
// something changes; main hands the combined list back to every window. So the
// sidebar in any window shows panes in all of them, ⌘J can jump across
// windows, and the Dock badge counts the panes waiting on you.
// ===========================================================================

const SIDEBAR_KEY = 'discovibe.sidebar.v1';
const SIDEBAR_UNFINISHED_PAGE = 40;
const WORKING_WINDOW_MS = 4000;     // output this recent, and not your own typing echo = working
const QUESTION_QUIET_MS = 3000;     // quiet this long before a visible question counts

let sidebarOpen = true;
let sidebarSide = 'left';            // 'left' or 'right', your pick
try {
  const v = JSON.parse(localStorage.getItem(SIDEBAR_KEY));
  if (v && typeof v.open === 'boolean') sidebarOpen = v.open;
  if (v && (v.side === 'left' || v.side === 'right')) sidebarSide = v.side;
} catch (_) {}
function saveSidebarPrefs() {
  try { localStorage.setItem(SIDEBAR_KEY, JSON.stringify({ open: sidebarOpen, side: sidebarSide })); } catch (_) {}
}
let sidebarRegistry = [];
let sidebarSessions = null;          // from sessionIndex, refreshed every minute while open
let sidebarSessionsAt = 0;
let sidebarShowAll = false;
let sidebarSearch = '';
const sidebarFold = {};   // section key -> false when folded; "Open" starts folded when long

// ---- Pane state -------------------------------------------------------------
// waiting  = a question is on screen, the bell rang, or Claude finished a turn
//            you started and has gone quiet. Cleared by typing in the pane.
// working  = output in the last few seconds that is not your own typing.
// idle     = everything else (a shell prompt, a restored conversation).
function paneState(p) {
  const now = Date.now();
  const lastData = p.lastDataAt || 0;
  const lastKey = p.lastKeypress || 0;
  if (p.attnTimer || p.el.classList.contains('attn')) return 'waiting';
  if (p.bellAt && p.bellAt > lastKey) return 'waiting';
  const quiet = now - lastData;
  const redraw = p.resizedAt && lastData - p.resizedAt < 1500;   // a resize makes the shell repaint
  if (quiet < WORKING_WINDOW_MS && lastData - lastKey > 1500 && !redraw) return 'working';
  if (quiet >= QUESTION_QUIET_MS && scanForPrompt(p)) return 'waiting';
  if (p.detectedTool === 'claude' && lastKey && lastData - lastKey > 5000 && quiet >= WORKING_WINDOW_MS) return 'waiting';
  return 'idle';
}

let lastReport = '';
function reportPanes() {
  const now = Date.now();
  const list = [...panes, ...stored].map((p) => {
    const state = paneState(p);
    if (p._sbState !== state) { p._sbState = state; p._sbSince = now; }
    return {
      id: p.id,
      name: (p.nameInput && p.nameInput.value) || p.name || 'Terminal',
      color: p.color || '',
      state, since: p._sbSince,
      sessionId: p.aiSessionId || '',
      cwd: p.cwd || '',
      collapsed: !!p.collapsed,
      focused: p.id === focusedId,
    };
  });
  const report = {
    key: WIN_KEY,
    name: (typeof windowName === 'string' && windowName) || (WIN_KEY === 'primary' ? 'Main window' : WIN_KEY),
    repoRoot: windowMeta.repoRoot || '',
    panes: list,
  };
  const json = JSON.stringify(report);
  if (json === lastReport) return;
  lastReport = json;
  window.api.reportPanes(report);
}
setInterval(reportPanes, 1500);

// ---- Cross-window actions ---------------------------------------------------
window.api.onFocusPane(({ paneId } = {}) => {
  const pane = panes.find((p) => p.id === paneId) || stored.find((p) => p.id === paneId);
  if (!pane) return;
  if (pane.collapsed) restorePane(pane);
  setFocused(pane.id);
  setTimeout(() => { try { pane.term.focus(); } catch (_) {} }, 40);
  pane.el.classList.add('sb-flash');
  setTimeout(() => pane.el.classList.remove('sb-flash'), 900);
});

window.api.onResumeIn(({ session } = {}) => { if (session) resumeHere(session); });

function resumeHere(sess) {
  const p = addPane({ name: sess.paneName || (sess.title ? sess.title.slice(0, 24) : ''), cwd: sess.cwd });
  if (!p) return;
  p.aiSessionId = sess.id; p.detectedTool = 'claude';
  scheduleSave();
  runResume(p);
}

// Resume in the window that already holds this conversation's repo, so work
// stays one window per repo. Falls back to this window.
async function resumeSession(sess) {
  let target = null;
  try {
    const a = await window.api.consolidateAnalyze([{ sessionId: sess.id, cwd: sess.cwd }]);
    const repo = a && a.sessions && a.sessions[sess.id] && a.sessions[sess.id].repoRoot;
    if (repo) target = sidebarRegistry.find((w) => w.repoRoot === repo);
  } catch (_) {}
  if (target && target.key !== WIN_KEY) window.api.resumeIn(target.wcId, sess);
  else resumeHere(sess);
}

function allPanes() {
  const out = [];
  for (const w of sidebarRegistry) for (const p of (w.panes || [])) out.push({ ...p, wcId: w.wcId, winKey: w.key, winName: w.name, winFocused: w.focused });
  return out;
}

// ⌘J: oldest waiting pane first, skipping the one you are already in.
function jumpToNextWaiting() {
  const waiting = allPanes().filter((p) => p.state === 'waiting').sort((a, b) => a.since - b.since);
  if (!waiting.length) { flashMsg('Nothing is waiting on you'); return; }
  const here = (p) => p.winKey === WIN_KEY && p.id === focusedId;
  const next = waiting.find((p) => !here(p)) || waiting[0];
  window.api.focusPane(next.wcId, next.id);
}

// ---- DOM --------------------------------------------------------------------
const sidebarEl = document.createElement('aside');
sidebarEl.id = 'sidebar';
document.body.appendChild(sidebarEl);

// When the sidebar is hidden, a labelled tab stays on that edge so it is easy to bring back.
const sidebarTab = document.createElement('button');
sidebarTab.id = 'sidebar-tab';
sidebarTab.title = 'Show the Sessions sidebar (⌘⇧B)';
sidebarTab.addEventListener('click', () => setSidebar(true));
document.body.appendChild(sidebarTab);

function applySidebarSide() {
  document.body.classList.toggle('sidebar-right', sidebarSide === 'right');
  sidebarTab.innerHTML = lic(sidebarSide === 'right' ? 'chevron-left' : 'chevron-right') + '<span>Sessions</span>';
  const btn = document.getElementById('btn-sidebar');
  if (btn) { btn.innerHTML = lic(sidebarSide === 'right' ? 'panel-right' : 'panel-left'); }
  renderIcons();
}
function setSidebarSide(side) {
  sidebarSide = side === 'right' ? 'right' : 'left';
  saveSidebarPrefs();
  applySidebarSide();
  renderSidebar();
  requestAnimationFrame(() => { relayout(); panes.forEach(fitPane); });
}

function setSidebar(open) {
  sidebarOpen = !!open;
  saveSidebarPrefs();
  document.body.classList.toggle('sidebar-on', sidebarOpen);
  const btn = document.getElementById('btn-sidebar');
  if (btn) btn.classList.toggle('active', sidebarOpen);
  if (sidebarOpen) { refreshSessions(); renderSidebar(); }
  requestAnimationFrame(() => { relayout(); panes.forEach(fitPane); });
}

async function refreshSessions(force) {
  if (!sidebarOpen) return;
  if (!force && Date.now() - sidebarSessionsAt < 60000 && sidebarSessions) return;
  sidebarSessionsAt = Date.now();
  try {
    const data = await window.api.sessionIndex();
    sidebarSessions = (data && data.sessions || []).filter((s) => !s.host || !data.host || s.host === data.host);
  } catch (_) { sidebarSessions = sidebarSessions || []; }
  renderSidebar();
}
setInterval(() => refreshSessions(false), 15000);

function ago(ts) {
  if (!ts) return '';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}
const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shortPath = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

function section(title, count, cls, foldKey) {
  const wrap = document.createElement('div'); wrap.className = 'sb-sec ' + (cls || '');
  const hd = document.createElement('div'); hd.className = 'sb-hd';
  const folded = foldKey && sidebarFold[foldKey] === false;
  hd.innerHTML = (foldKey ? lic(folded ? 'chevron-right' : 'chevron-down') : '') + `<span>${esc(title)}</span><span class="sb-count">${count}</span>`;
  if (foldKey) {
    hd.classList.add('sb-foldable');
    hd.addEventListener('click', () => { sidebarFold[foldKey] = !(sidebarFold[foldKey] !== false); renderSidebar(); });
  }
  const body = document.createElement('div'); body.className = 'sb-body';
  if (folded) body.hidden = true;
  wrap.append(hd, body);
  return { wrap, body };
}

function paneRow(p, showWin) {
  const row = document.createElement('button');
  row.className = 'sb-row sb-' + p.state + (p.winKey === WIN_KEY && p.focused ? ' sb-current' : '');
  const label = p.state === 'waiting' ? 'waiting ' + ago(p.since) : p.state === 'working' ? 'working' : (p.collapsed ? 'stored' : 'idle');
  row.innerHTML =
    `<span class="sb-dot" style="background:${/^#[0-9a-f]{3,8}$/i.test(p.color || '') ? p.color : '#888'}"></span>` +
    `<span class="sb-main"><span class="sb-name">${esc(p.name)}</span>` +
    (showWin ? `<span class="sb-sub">${esc(p.winName)}</span>` : '') + `</span>` +
    `<span class="sb-state">${esc(label)}</span>`;
  row.title = 'Go to this terminal' + (showWin ? ' (in ' + p.winName + ')' : '');
  row.addEventListener('click', () => window.api.focusPane(p.wcId, p.id));
  return row;
}

function renderSidebar() {
  if (!sidebarOpen) return;
  const scroll = sidebarEl.querySelector('.sb-scroll');
  const keepTop = scroll ? scroll.scrollTop : 0;
  const hadFocus = document.activeElement && document.activeElement.classList.contains('sb-search');
  sidebarEl.innerHTML = '';

  const top = document.createElement('div'); top.className = 'sb-top';
  top.innerHTML = `<span class="sb-title">${lic('list-checks')} Sessions</span>`;
  const tools = document.createElement('span'); tools.className = 'sb-tools';
  const other = sidebarSide === 'left' ? 'right' : 'left';
  const swap = document.createElement('button'); swap.className = 'sb-x';
  swap.innerHTML = lic('arrow-left-right') + `<span>Move ${other}</span>`;
  swap.title = `Put the sidebar on the ${other} side`;
  swap.addEventListener('click', () => setSidebarSide(other));
  const hide = document.createElement('button'); hide.className = 'sb-x sb-hide';
  hide.innerHTML = lic(sidebarSide === 'left' ? 'panel-left-close' : 'panel-right-close') + '<span>Hide</span>';
  hide.title = 'Hide the sidebar (⌘⇧B)';
  hide.addEventListener('click', () => setSidebar(false));
  tools.append(swap, hide);
  top.appendChild(tools);
  sidebarEl.appendChild(top);

  // Search sits at the top and filters every section, not just Unfinished.
  const search = document.createElement('input'); search.type = 'search'; search.className = 'sb-search';
  search.placeholder = 'Search sessions…'; search.value = sidebarSearch; search.spellcheck = false;
  search.addEventListener('input', () => { sidebarSearch = search.value; sidebarShowAll = false; renderSidebar(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); sidebarSearch = ''; renderSidebar(); } });
  const sw = document.createElement('div'); sw.className = 'sb-searchwrap'; sw.appendChild(search);
  sidebarEl.appendChild(sw);

  const body = document.createElement('div'); body.className = 'sb-scroll';
  sidebarEl.appendChild(body);

  const q = sidebarSearch.trim().toLowerCase();
  const hit = (...vals) => !q || vals.some((v) => String(v || '').toLowerCase().includes(q));
  const allOpen = allPanes();
  const all = allOpen.filter((p) => hit(p.name, p.winName));
  const multiWin = sidebarRegistry.length > 1;
  const waiting = all.filter((p) => p.state === 'waiting').sort((a, b) => a.since - b.since);
  const working = all.filter((p) => p.state === 'working');
  const idle = all.filter((p) => p.state === 'idle');

  const w = section('Needs you', waiting.length, 'sb-needs');
  if (!waiting.length) { const e = document.createElement('div'); e.className = 'sb-empty'; e.textContent = q ? 'Nothing matches.' : 'Nothing waiting. ⌘J jumps to the next one when there is.'; w.body.appendChild(e); }
  waiting.forEach((p) => w.body.appendChild(paneRow(p, multiWin)));
  body.appendChild(w.wrap);

  if (working.length) {
    const s = section('Working', working.length, 'sb-working');
    working.forEach((p) => s.body.appendChild(paneRow(p, multiWin)));
    body.appendChild(s.wrap);
  }

  if (idle.length) {
    if (sidebarFold.open === undefined) sidebarFold.open = idle.length <= 8;
    const s = section('Open', idle.length, 'sb-open', 'open');
    idle.forEach((p) => s.body.appendChild(paneRow(p, multiWin)));
    body.appendChild(s.wrap);
  }

  // Unfinished conversations that are not open in any pane.
  const openIds = new Set(allOpen.map((p) => p.sessionId).filter(Boolean));
  const unfinished = (sidebarSessions || [])
    .filter((s) => !s.completedAt && !openIds.has(s.id))
    .filter((s) => hit(s.paneName, s.title, s.cwd, s.lastPrompt));
  const u = section('Unfinished, not open', sidebarSessions ? unfinished.length : '…', 'sb-unfinished');
  const shown = sidebarShowAll ? unfinished : unfinished.slice(0, SIDEBAR_UNFINISHED_PAGE);
  for (const s of shown) {
    const row = document.createElement('div'); row.className = 'sb-row sb-sess';
    const name = s.paneName || s.title || 'Untitled session';
    const alt = s.paneName && s.title && s.title !== s.paneName ? s.title : '';
    row.innerHTML =
      `<span class="sb-main"><span class="sb-name">${esc(name)}</span>` +
      `<span class="sb-sub">${esc([ago(s.mtime), alt || shortPath(s.cwd)].filter(Boolean).join(' · '))}</span></span>`;
    row.title = (s.lastPrompt ? 'Last: “' + s.lastPrompt.replace(/\s+/g, ' ').slice(0, 200) + '”\n' : '') + shortPath(s.cwd);
    const go = document.createElement('button'); go.className = 'sb-act'; go.innerHTML = lic('play');
    go.title = 'Resume this conversation (in its repo window when one is open)';
    go.addEventListener('click', () => resumeSession(s));
    const done = document.createElement('button'); done.className = 'sb-act'; done.innerHTML = lic('check');
    done.title = 'Closed for good: mark it done and drop it from this list';
    done.addEventListener('click', async () => {
      try { await window.api.sessionComplete(s.id, true); } catch (_) {}
      s.completedAt = new Date().toISOString();
      renderSidebar();
    });
    row.append(go, done);
    u.body.appendChild(row);
  }
  if (sidebarSessions && !unfinished.length) { const e = document.createElement('div'); e.className = 'sb-empty'; e.textContent = q ? 'Nothing matches.' : 'All caught up.'; u.body.appendChild(e); }
  if (unfinished.length > shown.length) {
    const more = document.createElement('button'); more.className = 'sb-more';
    more.textContent = `Show all ${unfinished.length}`;
    more.addEventListener('click', () => { sidebarShowAll = true; renderSidebar(); });
    u.body.appendChild(more);
  }
  body.appendChild(u.wrap);

  renderIcons();
  const sc = sidebarEl.querySelector('.sb-scroll'); if (sc) sc.scrollTop = keepTop;
  if (hadFocus) { const s2 = sidebarEl.querySelector('.sb-search'); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); } }
}

// Re-render on registry changes, but not while you are typing in the search box
// mid-word more often than needed: coalesce to one frame.
let sbRaf = 0;
function scheduleSidebar() { if (sbRaf) return; sbRaf = requestAnimationFrame(() => { sbRaf = 0; renderSidebar(); }); }
window.api.onPaneRegistry((snap) => { sidebarRegistry = Array.isArray(snap) ? snap : []; scheduleSidebar(); });
// Ages ("waiting 3m") tick even when nothing else changes.
setInterval(() => { if (sidebarOpen) scheduleSidebar(); }, 30000);

// Toolbar button, next to Outstanding work.
(() => {
  const work = document.getElementById('btn-work');
  if (!work) return;
  const b = document.createElement('button');
  b.id = 'btn-sidebar'; b.className = 'tb-btn';
  b.title = 'Sessions sidebar (⌘⇧B)'; b.setAttribute('data-tooltip', 'Sessions sidebar (⌘⇧B)');
  b.innerHTML = lic('panel-left');
  b.addEventListener('click', () => setSidebar(!sidebarOpen));
  work.after(b);
})();
applySidebarSide();

window.api.paneRegistry().then((snap) => { sidebarRegistry = Array.isArray(snap) ? snap : []; setSidebar(sidebarOpen); }).catch(() => setSidebar(sidebarOpen));
reportPanes();
