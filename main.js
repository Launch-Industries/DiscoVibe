'use strict';

const { app, BrowserWindow, ipcMain, screen, Menu, session, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const pty = require('node-pty');
const { autoUpdater } = require('electron-updater');

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
let splashWin = null;
function createSplash() {
  splashWin = new BrowserWindow({
    width: 560, height: 360,
    frame: false, transparent: true, resizable: false, movable: false,
    center: true, show: false, skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  splashWin.loadFile(path.join(__dirname, 'renderer', 'splash.html'), {
    query: { v: app.getVersion() }   // never hardcode the number; it drifts
  });
  splashWin.once('ready-to-show', () => { if (splashWin && !splashWin.isDestroyed()) splashWin.show(); });
  // A renderer that never reaches ready-to-show must not strand an always-on-top
  // window over everything else on the desktop.
  setTimeout(closeSplash, 10000);
}
function closeSplash() {
  if (!splashWin) return;
  const w = splashWin;
  splashWin = null;               // cleared first: closing is idempotent, and every
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
