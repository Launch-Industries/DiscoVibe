'use strict';

const { app, BrowserWindow, ipcMain, screen, Menu, session, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const pty = require('node-pty');
const { autoUpdater } = require('electron-updater');

// Dev runs (`npm start`) share a userData dir with an installed DiscoVibe.app,
// so the single-instance lock below made them quit on the spot, silently, any
// time the packaged app was already open. Give unpackaged runs their own dir
// (and therefore their own lock and their own saved layout). An explicit
// --user-data-dir on the command line still wins.
if (!app.isPackaged && !process.argv.some((a) => a.startsWith('--user-data-dir'))) {
  const dir = app.getPath('userData');
  app.setPath('userData', path.join(path.dirname(dir), path.basename(dir) + ' (dev)'));
}

function loginShell() { return process.env.SHELL || '/bin/zsh'; }

// Map of paneId -> pty process (ids are globally unique across all windows)
const ptys = new Map();
// All open TileTerm windows
const windows = new Set();
let isQuitting = false;

// Persist which windows are open (and on which display) so a crash/quit restores them.
function windowsFile() { return path.join(app.getPath('userData'), 'windows.json'); }
function persistWindows() {
  try {
    const list = [...windows].filter((w) => !w.isDestroyed()).map((w) => ({ displayId: w.__displayId, role: w.__role, key: w.__key }));
    fs.writeFileSync(windowsFile(), JSON.stringify(list));
  } catch (_) {}
}
function readWindows() {
  try { return JSON.parse(fs.readFileSync(windowsFile(), 'utf8')); } catch (_) { return []; }
}

function defaultShell() {
  if (os.platform() === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

function attachDebug(win) {
  if (!process.env.TILETERM_DEBUG) return;
  const wc = win.webContents;
  wc.on('console-message', (_e, level, message, line, source) => {
    console.log(`[renderer:${level}] ${message} (${source}:${line})`);
  });
  wc.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[did-fail-load] ${code} ${desc} ${url}`);
  });
  wc.on('render-process-gone', (_e, details) => {
    console.log('[render-process-gone]', JSON.stringify(details));
  });
  wc.openDevTools({ mode: 'detach' });
}

function windowForDisplay(displayId) {
  for (const w of windows) if (w.__displayId === displayId) return w;
  return null;
}

// ---- Project name -----------------------------------------------------------
// What someone calls "the project" is the folder holding .git, not whichever
// subdirectory the shell happens to be sitting in: cd into src/components and it
// is still the same repo. So walk up for .git and name the window after that.
const projectNameCache = new Map();
function projectNameFor(dir) {
  if (!dir) return '';
  if (projectNameCache.has(dir)) return projectNameCache.get(dir);
  let name = '';
  try {
    const start = path.resolve(dir);
    const root = path.parse(start).root;
    let cur = start;
    // Bounded: a pathological path must not turn every prompt into a long walk.
    for (let i = 0; i < 40 && cur && cur !== root; i++) {
      if (fs.existsSync(path.join(cur, '.git'))) { name = path.basename(cur); break; }
      cur = path.dirname(cur);
    }
    // Not a repo: the folder itself is the best answer available. Home is the
    // exception — it means "not in a project", not a project named after the user.
    if (!name && start !== os.homedir() && start !== root) name = path.basename(start);
  } catch (_) {}
  projectNameCache.set(dir, name);
  return name;
}
ipcMain.handle('project-name', (_e, { dir }) => ({ name: projectNameFor(dir) }));

ipcMain.on('set-window-title', (event, { title }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.setTitle((title || '').trim() || 'DiscoVibe');
});

// ---- Splash -----------------------------------------------------------------
// A frameless 560x360 window on the app's own --chrome-bg, shown while the first
// renderer boots. Held only as long as that takes: a fixed minimum would make
// startup feel slower than it is.
const SPLASH_MIN_MS = 4000;   // deliberate hold, not a load time
let splashWin = null;
let splashShownAt = 0;
let splashTimer = null;

function createSplash() {
  const b = screen.getPrimaryDisplay().bounds;
  splashWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: false, resizable: false, movable: false,
    show: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
    backgroundColor: '#04050f',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  // Above the menu bar and Dock, so full screen means the whole screen. Not
  // macOS's native fullscreen, which would animate into its own Space and take
  // longer to leave than the splash is on screen for.
  splashWin.setAlwaysOnTop(true, 'screen-saver');
  splashWin.loadFile(path.join(__dirname, 'renderer', 'splash.html'), {
    query: { v: app.getVersion() }   // never hardcode the number; it drifts
  });
  splashWin.once('ready-to-show', () => {
    if (!splashWin || splashWin.isDestroyed()) return;
    splashWin.show();
    splashShownAt = Date.now();
  });
  // A renderer that never reaches ready-to-show must not strand a window that
  // sits above everything else on the desktop.
  setTimeout(() => closeSplash(true), SPLASH_MIN_MS + 8000);
}

// The main window is ready long before the hold expires, so it is revealed
// behind the splash and this only decides when the cover comes off.
function closeSplash(force) {
  if (!splashWin) return;
  const waited = splashShownAt ? Date.now() - splashShownAt : SPLASH_MIN_MS;
  if (!force && waited < SPLASH_MIN_MS) {
    if (!splashTimer) splashTimer = setTimeout(() => { splashTimer = null; closeSplash(true); }, SPLASH_MIN_MS - waited);
    return;
  }
  const w = splashWin;
  splashWin = null;               // cleared first: closing is idempotent, and every
  if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
  if (!w.isDestroyed()) w.close(); // window's ready-to-show calls in here.
}

function createWindow(display, role) {
  display = display || screen.getPrimaryDisplay();
  const wa = display.workArea;

  const win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    title: 'DiscoVibe',
    backgroundColor: '#0b0e14',
    show: false,   // revealed on ready-to-show; the splash covers the gap
    titleBarStyle: 'hiddenInset', // keeps native traffic lights, gives us the full canvas
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: true        // companion browser per pane
    }
  });

  win.__displayId = display.id;
  win.__role = role || 'primary';
  win.__key = (role === 'primary' || !role) ? 'primary' : String(display.id);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { role: win.__role, key: win.__key }
  });
  win.maximize();
  // Paint-ready is the honest moment to swap: the window has content, so the
  // splash goes away exactly when it stops being useful, never on a timer.
  win.once('ready-to-show', () => { win.show(); closeSplash(); });
  // If that signal never arrives, an invisible window reads as an app that failed
  // to launch. Show it anyway rather than leave nothing on screen.
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) { win.show(); closeSplash(); }
  }, 8000);
  attachDebug(win);

  windows.add(win);
  persistWindows();
  // Update the registry only when closing a window while others remain; closing the
  // last window (or quitting) leaves the snapshot intact so everything reopens next launch.
  win.on('closed', () => { windows.delete(win); if (!isQuitting && windows.size > 0) persistWindows(); });
  return win;
}

// ---- Session transcripts ----------------------------------------------------
// Every PTY's output is mirrored to a file under userData/transcripts as it
// happens, so a terminal that gets closed by accident (or lost to a crash) can
// still be read back afterwards. The recovery UI lives in the renderer.

const MAX_TRANSCRIPTS = 200;          // keep at most this many sessions on disk
const TRANSCRIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const transcripts = new Map();        // ptyId -> { logPath, metaPath, meta, stream }
let transcriptDirCache = null;

function transcriptsDir() {
  if (!transcriptDirCache) {
    transcriptDirCache = path.join(app.getPath('userData'), 'transcripts');
    try { fs.mkdirSync(transcriptDirCache, { recursive: true }); } catch (_) {}
  }
  return transcriptDirCache;
}

function writeTranscriptMeta(rec) {
  try { fs.writeFileSync(rec.metaPath, JSON.stringify(rec.meta), 'utf8'); } catch (_) {}
}

function transcriptOpen(id, info = {}) {
  transcriptClose(id);
  const dir = transcriptsDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${stamp}-${String(id).replace(/[^\w.-]+/g, '_')}`;
  const rec = {
    logPath: path.join(dir, base + '.log'),
    metaPath: path.join(dir, base + '.json'),
    meta: {
      base,
      paneId: id,
      name: info.name || '',
      color: info.color || '',
      cwd: info.cwd || '',
      started: Date.now(),
      ended: null
    },
    stream: null
  };
  try { rec.stream = fs.createWriteStream(rec.logPath, { flags: 'a' }); } catch (_) { return null; }
  rec.stream.on('error', () => {});
  transcripts.set(id, rec);
  writeTranscriptMeta(rec);
  pruneTranscripts();
  return base;
}

function transcriptWrite(id, data) {
  const rec = transcripts.get(id);
  if (rec && rec.stream) { try { rec.stream.write(data); } catch (_) {} }
}

function transcriptUpdate(id, patch) {
  const rec = transcripts.get(id);
  if (!rec) return;
  Object.assign(rec.meta, patch || {});
  writeTranscriptMeta(rec);
}

function transcriptClose(id) {
  const rec = transcripts.get(id);
  if (!rec) return;
  rec.meta.ended = Date.now();
  writeTranscriptMeta(rec);
  try { rec.stream.end(); } catch (_) {}
  transcripts.delete(id);
}

// Drop transcripts that are too old or beyond the cap. Never touches a session
// that is still recording.
function pruneTranscripts() {
  const dir = transcriptsDir();
  const live = new Set([...transcripts.values()].map((r) => r.meta.base));
  let entries;
  try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return; }
  const items = entries.map((f) => {
    const base = f.slice(0, -5);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) {}
    return { base, started: (meta && meta.started) || 0 };
  }).sort((a, b) => b.started - a.started);

  const cutoff = Date.now() - TRANSCRIPT_MAX_AGE_MS;
  items.forEach((it, idx) => {
    if (live.has(it.base)) return;
    if (idx < MAX_TRANSCRIPTS && it.started >= cutoff) return;
    try { fs.unlinkSync(path.join(dir, it.base + '.log')); } catch (_) {}
    try { fs.unlinkSync(path.join(dir, it.base + '.json')); } catch (_) {}
  });
}

// Strip ANSI escapes / OSC sequences so a transcript reads as plain text.
function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function readTranscriptText(base, maxBytes = 4 * 1024 * 1024) {
  const file = path.join(transcriptsDir(), path.basename(base) + '.log');
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return { ok: false, error: 'Transcript file is gone' }; }
  const start = Math.max(0, stat.size - maxBytes);
  let raw = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
  return { ok: true, text: stripAnsi(raw), truncated: start > 0, size: stat.size };
}

// Newest-first list of recorded sessions, each with a short tail preview.
// ---- Claude Code session discovery -----------------------------------------
// `claude -c` continues the MOST RECENT conversation in a directory, so several
// panes sharing a cwd all resume the same one. Claude stores each conversation
// as its own file under ~/.claude/projects/<cwd with non-alphanumerics as ->/,
// named by session uuid, so a pane can instead resume the exact session it was
// running via `claude --resume <uuid>`.
function claudeProjectDir(cwd) {
  if (!cwd) return null;
  return path.join(os.homedir(), '.claude', 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'));
}

// ---- Outstanding-work tracker ----------------------------------------------
// Claude Code writes one .jsonl per conversation and, inside it, an `ai-title`
// record ("Presentations site bugs and reorganization") plus a `last-prompt`
// record. That is enough to list unfinished work in a way a human recognises,
// without opening the transcript.
//
// Completion is DiscoVibe's own state, kept beside the app's data so nothing
// ever writes into Claude's files. Records carry a hostname and timestamp so
// the same shape can sync between machines later.

function sessionStatusPath() {
  return path.join(app.getPath('userData'), 'session-status.json');
}
function readSessionStatus() {
  try { return JSON.parse(fs.readFileSync(sessionStatusPath(), 'utf8')) || {}; } catch (_) { return {}; }
}
function writeSessionStatus(map) {
  try { fs.writeFileSync(sessionStatusPath(), JSON.stringify(map, null, 2), 'utf8'); } catch (_) {}
}

// Read a slice from each end rather than the whole file: these run to tens of
// megabytes, the title/prompt records are rewritten as the session goes so the
// newest are near the end, and the opening user message is a good fallback
// title for a session too short to have earned an ai-title yet.
function readJsonlEdge(file, size, fromEnd, bytes) {
  const len = Math.min(size, bytes);
  const pos = fromEnd ? size - len : 0;
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return ''; }
  const buf = Buffer.alloc(len);
  try { fs.readSync(fd, buf, 0, len, pos); } finally { try { fs.closeSync(fd); } catch (_) {} }
  let text = buf.toString('utf8');
  if (fromEnd && size > len) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); }
  return text;
}

function firstUserText(d) {
  const c = d && d.message && d.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) { for (const part of c) if (part && part.type === 'text' && part.text) return part.text; }
  return '';
}

function readSessionMeta(file) {
  let size = 0;
  let mtime = 0;
  try { const st = fs.statSync(file); size = st.size; mtime = st.mtimeMs; } catch (_) { return null; }

  const meta = { id: path.basename(file, '.jsonl'), title: '', lastPrompt: '', cwd: '', mtime, size };

  const scan = (text, isTail) => {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch (_) { continue; }
      if (d.cwd && !meta.cwd) meta.cwd = d.cwd;
      if (d.type === 'ai-title' && d.aiTitle) meta.title = d.aiTitle;          // last wins
      if (d.type === 'last-prompt' && d.lastPrompt) meta.lastPrompt = d.lastPrompt;
      if (!isTail && !meta.firstPrompt && d.type === 'user') {
        const t = firstUserText(d).trim();
        if (t && !t.startsWith('<')) meta.firstPrompt = t;
      }
    }
  };
  scan(readJsonlEdge(file, size, true, 256 * 1024), true);
  if (!meta.title || !meta.cwd) scan(readJsonlEdge(file, size, false, 64 * 1024), false);
  if (!meta.title) meta.title = (meta.firstPrompt || '').slice(0, 80);
  delete meta.firstPrompt;
  return meta;
}

ipcMain.handle('session-index', () => {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const status = readSessionStatus();
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(root); } catch (_) { return { host: os.hostname(), sessions: [] }; }
  for (const d of dirs) {
    let files;
    try { files = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of files) {
      const m = readSessionMeta(path.join(root, d, f));
      if (!m) continue;
      const st = status[m.id] || null;
      out.push({ ...m, projectDir: d, host: os.hostname(),
                 completedAt: st && st.completedAt ? st.completedAt : null });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return { host: os.hostname(), sessions: out };
});

// Optional cross-machine sync.
//
// Off unless the user configures it. DiscoVibe ships to people we do not know
// (see DISTRIBUTION.md), so no endpoint or token is baked in: without config a
// machine stays entirely local, which is the sane default. When configured, the
// call goes to an edge function holding the service-role key, never straight at
// the table, because the rows contain prompt text.
function syncConfigPath() { return path.join(app.getPath('userData'), 'sync-config.json'); }
function readSyncConfig() {
  try { return JSON.parse(fs.readFileSync(syncConfigPath(), 'utf8')) || null; } catch (_) { return null; }
}

ipcMain.handle('session-sync-config', (_e, patch) => {
  if (patch === undefined) {
    const c = readSyncConfig();
    // Never hand the token back to the renderer; it only needs to know if set.
    return c ? { url: c.url || '', anonKey: c.anonKey ? '(set)' : '', token: c.token ? '(set)' : '' } : null;
  }
  try { fs.writeFileSync(syncConfigPath(), JSON.stringify(patch || {}, null, 2), 'utf8'); } catch (_) {}
  return { ok: true };
});

ipcMain.handle('session-sync', async (_e, { sessions } = {}) => {
  const cfg = readSyncConfig();
  if (!cfg || !cfg.url || !cfg.token) return { ok: false, reason: 'not-configured' };
  try {
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.anonKey ? { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey } : {}),
      },
      body: JSON.stringify({ token: cfg.token, action: 'sync', host: os.hostname(), sessions: sessions || [] }),
    });
    if (!r.ok) return { ok: false, reason: 'http-' + r.status };
    const data = await r.json();
    // Remote completion wins over local silence: a tick made on another Mac
    // should show here, and the local file is the offline cache.
    const status = readSessionStatus();
    for (const row of (data.sessions || [])) {
      if (row.completed_at && !status[row.session_id]) {
        status[row.session_id] = { completedAt: row.completed_at, host: row.device_hostname || '' };
      }
    }
    writeSessionStatus(status);
    return { ok: true, sessions: data.sessions || [] };
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err) };
  }
});

async function pushCompletion(id, completed) {
  const cfg = readSyncConfig();
  if (!cfg || !cfg.url || !cfg.token) return;
  try {
    await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.anonKey ? { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey } : {}),
      },
      body: JSON.stringify({ token: cfg.token, action: 'complete', id, completed, host: os.hostname() }),
    });
  } catch (_) {}
}

ipcMain.handle('session-complete', (_e, { id, completed } = {}) => {
  if (!id) return { ok: false };
  const status = readSessionStatus();
  if (completed) status[id] = { completedAt: new Date().toISOString(), host: os.hostname() };
  else delete status[id];
  writeSessionStatus(status);
  pushCompletion(id, !!completed);          // fire-and-forget; local state already saved
  return { ok: true };
});

ipcMain.handle('claude-sessions', (_e, { cwd } = {}) => {
  const dir = claudeProjectDir(cwd);
  if (!dir) return [];
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { return []; }
  return files.map((f) => {
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch (_) {}
    return { id: f.slice(0, -6), mtime };
  }).sort((a, b) => b.mtime - a.mtime);
});

ipcMain.handle('list-transcripts', () => {
  const dir = transcriptsDir();
  const live = new Set([...transcripts.values()].map((r) => r.meta.base));
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    const base = meta.base || f.slice(0, -5);
    let size = 0;
    try { size = fs.statSync(path.join(dir, base + '.log')).size; } catch (_) {}
    const tail = readTranscriptText(base, 4000);
    const preview = tail.ok
      ? tail.text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' · ').slice(0, 220)
      : '';
    out.push({ ...meta, base, size, preview, active: live.has(base) });
  }
  return out.sort((a, b) => (b.started || 0) - (a.started || 0));
});

ipcMain.handle('read-transcript', (_e, { base }) => readTranscriptText(base));

ipcMain.handle('delete-transcript', (_e, { base }) => {
  const dir = transcriptsDir();
  try { fs.unlinkSync(path.join(dir, path.basename(base) + '.log')); } catch (_) {}
  try { fs.unlinkSync(path.join(dir, path.basename(base) + '.json')); } catch (_) {}
  return { ok: true };
});

ipcMain.handle('reveal-transcript', (_e, { base }) => {
  const file = path.join(transcriptsDir(), path.basename(base) + '.log');
  if (fs.existsSync(file)) shell.showItemInFolder(file);
  return { ok: fs.existsSync(file), path: file };
});

ipcMain.on('transcript-meta', (_e, { id, patch }) => transcriptUpdate(id, patch));

// ---- PTY lifecycle over IPC -------------------------------------------------

ipcMain.handle('pty-spawn', (event, opts = {}) => {
  const { id, cols = 80, rows = 24, cwd, shell } = opts;
  const shellPath = shell || defaultShell();

  let dir = (cwd || '').trim();
  if (dir.startsWith('~')) dir = path.join(os.homedir(), dir.slice(1));
  if (!dir || !fs.existsSync(dir)) dir = os.homedir();

  let proc;
  try {
    proc = pty.spawn(shellPath, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: dir,
      // TERM_PROGRAM overridden so zsh's Apple-Terminal update_terminal_cwd hook
      // doesn't try to write to a file descriptor only Terminal.app provides
      // (otherwise: "update_terminal_cwd: bad file descriptor").
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'xterm-256color', TERM_PROGRAM_VERSION: '' }
    });
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }

  ptys.set(id, proc);
  const wc = event.sender;
  const transcript = transcriptOpen(id, { name: opts.name, color: opts.color, cwd: dir });

  proc.onData((data) => {
    transcriptWrite(id, data);
    if (!wc.isDestroyed()) wc.send('pty-data', { id, data });
  });
  proc.onExit(({ exitCode }) => {
    transcriptClose(id);
    if (!wc.isDestroyed()) wc.send('pty-exit', { id, exitCode });
    ptys.delete(id);
  });

  return { ok: true, id, shell: shellPath, pid: proc.pid, cwd: dir, transcript };
});

ipcMain.on('pty-input', (_e, { id, data }) => {
  const proc = ptys.get(id);
  if (proc) proc.write(data);
});

ipcMain.on('pty-resize', (_e, { id, cols, rows }) => {
  const proc = ptys.get(id);
  if (proc && cols > 0 && rows > 0) {
    try { proc.resize(cols, rows); } catch (_) { /* race on teardown */ }
  }
});

ipcMain.on('pty-kill', (_e, { id }) => {
  transcriptClose(id);
  const proc = ptys.get(id);
  if (proc) {
    try { proc.kill(); } catch (_) {}
    ptys.delete(id);
  }
});

// ---- Display detection ------------------------------------------------------

function describeDisplays() {
  const all = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  return all.map((d, i) => ({
    id: d.id,
    index: i,
    label: d.label || `Display ${i + 1}`,
    width: d.size.width,
    height: d.size.height,
    workWidth: d.workArea.width,
    workHeight: d.workArea.height,
    scaleFactor: d.scaleFactor,
    primary: d.id === primaryId,
    hasWindow: !!windowForDisplay(d.id)
  }));
}

ipcMain.handle('get-displays', () => describeDisplays());

// Run a usage command (e.g. ccusage) and return its output for the usage bar.
ipcMain.handle('run-usage', (_e, { command }) => new Promise((resolve) => {
  if (!command) return resolve({ ok: false });
  const p = spawn(loginShell(), ['-lc', command], { timeout: 15000 });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d.toString(); });
  p.stderr.on('data', (d) => { err += d.toString(); });
  p.on('close', (code) => resolve({ ok: code === 0, out, err }));
  p.on('error', (e2) => resolve({ ok: false, err: String(e2.message) }));
}));

// Pick a local file to preview in a pane's companion browser.
ipcMain.handle('pick-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open file in companion browser',
    properties: ['openFile'],
    filters: [{ name: 'Web', extensions: ['html', 'htm', 'svg', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'json', 'txt', 'md'] }, { name: 'All', extensions: ['*'] }]
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false };
  return { ok: true, path: filePaths[0] };
});

// Pick a folder (projects directory for new terminals).
ipcMain.handle('pick-folder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose your projects folder', properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false };
  return { ok: true, path: filePaths[0] };
});

// ===========================================================================
// Dropped-file staging
// ===========================================================================
// A screenshot dragged straight off the macOS capture thumbnail lives under
// .../T/TemporaryItems/NSIRD_screencaptureui_XXXX/. macOS reclaims that folder
// as soon as the thumbnail flow ends, and sandboxing keeps other processes out
// of it even before then, so a path pointing there is useless to whatever runs
// in the terminal. The drop is the one moment the bytes are reachable: copy
// them here and hand on this path instead.
function droppedDir() {
  const dir = path.join(app.getPath('userData'), 'dropped');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

// A fortnight: long enough to reopen a screenshot from an earlier session,
// short enough that the folder never turns into a junk drawer.
const DROPPED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
function pruneDropped() {
  let names;
  const dir = droppedDir();
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  const cutoff = Date.now() - DROPPED_MAX_AGE_MS;
  for (const name of names) {
    const file = path.join(dir, name);
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch (_) {}
  }
}

ipcMain.handle('persist-dropped', async (_event, { name, data }) => {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const safe = (String(name || '').replace(/[^\w.-]+/g, '-').replace(/^-+/, '').slice(-64)) || 'drop';
    const filePath = path.join(droppedDir(), `${stamp}-${safe}`);
    await fs.promises.writeFile(filePath, Buffer.from(data));
    return { ok: true, filePath };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

// Save a terminal's output to a file the user picks.
ipcMain.handle('save-output', async (event, { name, text }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const safe = String(name || 'terminal').replace(/[^\w.-]+/g, '_');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save Terminal Output',
    defaultPath: path.join(os.homedir(), 'Downloads', `${safe}-${stamp}.txt`),
    filters: [{ name: 'Text', extensions: ['txt', 'log'] }]
  });
  if (canceled || !filePath) return { ok: false };
  try { await fs.promises.writeFile(filePath, text || '', 'utf8'); return { ok: true, filePath }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});

// Open a TileTerm window on every connected display (focus existing ones).
ipcMain.handle('span-displays', () => {
  const all = screen.getAllDisplays();
  let created = 0;
  for (const d of all) {
    const existing = windowForDisplay(d.id);
    if (existing) {
      existing.show();
      existing.focus();
    } else {
      createWindow(d, 'span');
      created += 1;
    }
  }
  return { displays: all.length, created };
});

function broadcastDisplays() {
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send('displays-changed');
  }
}

// Relay a message to every window (used for global settings like title size).
ipcMain.on('open-external', (_e, { url }) => { shell.openExternal(url).catch(() => {}); });

ipcMain.on('broadcast', (event, payload) => {
  for (const w of windows) {
    if (!w.isDestroyed() && w.webContents.id !== event.sender.id) {
      w.webContents.send('broadcast', payload);
    }
  }
});

// ---- App lifecycle ----------------------------------------------------------

function sendToFocused(action) {
  const win = BrowserWindow.getFocusedWindow() || [...windows][0];
  if (win) win.webContents.send('menu', action);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => sendToFocused('open-prefs') },
        { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Terminal',
      submenu: [
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+N', click: () => sendToFocused('new-terminal') },
        { label: 'New Terminal (⌘T)', accelerator: 'CmdOrCtrl+T', click: () => sendToFocused('new-terminal') },
        { label: 'Close Terminal', accelerator: 'CmdOrCtrl+W', click: () => sendToFocused('close-terminal') },
        { label: 'Reopen Closed Terminal', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendToFocused('reopen-closed') },
        { label: 'Recover Session…', accelerator: 'CmdOrCtrl+Shift+R', click: () => sendToFocused('recover-sessions') },
        { label: 'Close ALL Terminals (Killswitch)', accelerator: 'CmdOrCtrl+Shift+K', click: () => sendToFocused('kill-all') },
        { type: 'separator' },
        { label: 'Save Terminal Output…', accelerator: 'CmdOrCtrl+S', click: () => sendToFocused('save-output') },
        { label: 'Clear Terminal', accelerator: 'CmdOrCtrl+K', click: () => sendToFocused('clear') },
        { label: 'Collapse / Store Terminal', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendToFocused('collapse') },
        { label: 'Next Terminal', accelerator: 'CmdOrCtrl+]', click: () => sendToFocused('next') },
        { label: 'Previous Terminal', accelerator: 'CmdOrCtrl+[', click: () => sendToFocused('prev') },
        { type: 'separator' },
        { label: 'Span All Displays', accelerator: 'CmdOrCtrl+D', click: () => span() },
        { label: 'Toggle Mute Bell (sound)', accelerator: 'CmdOrCtrl+M', click: () => sendToFocused('toggle-mute') },
        { label: 'Toggle Alerts (flash + chime)', accelerator: 'CmdOrCtrl+E', click: () => sendToFocused('toggle-alerts') }
      ]
    },
    {
      // Custom Edit menu. The default 'editMenu' role binds Cmd+C to the native
      // Copy, which acts on the hidden xterm helper textarea and only ever holds
      // the current line — that's what truncated multi-line copies to one line.
      // Copy is routed to the renderer instead, which reads the real terminal
      // selection. Paste stays a role: it fires a native paste into xterm's
      // textarea, which is what produces correct bracketed-paste framing.
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => sendToFocused('copy') },
        { role: 'paste' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => sendToFocused('select-all') },
        // Cmd+A is the visible screen; the full scrollback is the deliberate,
        // shifted version, because 10,000 lines is rarely what someone means.
        { label: 'Select All Including Scrollback', accelerator: 'CmdOrCtrl+Shift+A', click: () => sendToFocused('select-all-scrollback') }
      ]
    },
    {
      // Custom View menu — deliberately OMITS Reload (Cmd+R) and Force Reload
      // (Cmd+Shift+R). The default 'viewMenu' role binds those, and an accidental
      // Cmd+R reloads the renderer and wipes every open terminal/pane (lost work).
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Span helper usable from the menu (mirrors the IPC handler).
function span() {
  const all = screen.getAllDisplays();
  for (const d of all) {
    const existing = windowForDisplay(d.id);
    if (existing) { existing.show(); existing.focus(); }
    else createWindow(d, 'span');
  }
}

// Single-instance lock: a second launch must NOT run concurrently (two instances
// racing the same saved-layout storage is what wiped windows). Focus the existing one.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log(`DiscoVibe is already running on ${app.getPath('userData')}; focusing that window instead.`);
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = [...windows][0];
    if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  });
}

// ── Auto-updater ─────────────────────────────────────────────────────────────
// Only runs in packaged builds (not dev mode).  Checks GitHub Releases for
// a newer version and shows a native dialog prompting the user to update.
autoUpdater.autoDownload = false;
autoUpdater.on('update-available', (info) => {
  const { response } = require('electron');
  dialog.showMessageBox({
    type: 'info', buttons: ['Download update', 'Later'],
    title: 'DiscoVibe update available',
    message: `Version ${info.version} is available.`,
    detail: 'Click "Download update" to get it in the background. DiscoVibe will prompt you to restart when it\'s ready.'
  }).then(({ response: r }) => {
    if (r === 0) autoUpdater.downloadUpdate();
  });
});
autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({
    type: 'info', buttons: ['Restart now', 'Later'],
    title: 'Update ready', message: 'Restart DiscoVibe to apply the update.'
  }).then(({ response: r }) => { if (r === 0) autoUpdater.quitAndInstall(); });
});
autoUpdater.on('error', () => {});   // silent — don't interrupt the user

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;   // another instance owns the session; don't touch it
  // Allow microphone for voice mode (local, trusted app).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(true);
  });

  pruneDropped();

  buildMenu();
  createSplash();

  // Restore the window set from the last session (crash/quit recovery).
  const saved = readWindows();
  const displays = screen.getAllDisplays();
  const hasPrimary = saved.some((w) => w.role === 'primary' || w.key === 'primary');
  if (saved.length && hasPrimary) {
    saved.forEach((w, i) => {
      const d = displays.find((dd) => String(dd.id) === String(w.displayId))
        || (i === 0 ? screen.getPrimaryDisplay() : displays[i % displays.length]);
      createWindow(d || screen.getPrimaryDisplay(), w.role || 'primary');
    });
  } else {
    createWindow(screen.getPrimaryDisplay(), 'primary');
  }

  // Finalize every open transcript on quit so recovery sees a clean end time.
  app.on('before-quit', () => { isQuitting = true; [...transcripts.keys()].forEach(transcriptClose); });
  // Check for updates 5 seconds after launch (only in packaged builds)
  if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);

  screen.on('display-added', broadcastDisplays);
  screen.on('display-removed', broadcastDisplays);
  screen.on('display-metrics-changed', broadcastDisplays);

  app.on('activate', () => {
    if (windows.size === 0) createWindow(screen.getPrimaryDisplay(), 'primary');
  });
});

app.on('window-all-closed', () => {
  ptys.forEach((p) => { try { p.kill(); } catch (_) {} });
  ptys.clear();
  app.quit();
});
