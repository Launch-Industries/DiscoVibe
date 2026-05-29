'use strict';

const { app, BrowserWindow, ipcMain, screen, Menu, session, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const pty = require('node-pty');

function loginShell() { return process.env.SHELL || '/bin/zsh'; }

// Map of paneId -> pty process (ids are globally unique across all windows)
const ptys = new Map();
// All open TileTerm windows
const windows = new Set();

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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { role: role || 'primary' }
  });
  win.maximize();
  attachDebug(win);

  windows.add(win);
  win.on('closed', () => windows.delete(win));
  return win;
}

// ---- PTY lifecycle over IPC -------------------------------------------------

ipcMain.handle('pty-spawn', (event, opts = {}) => {
  const { id, cols = 80, rows = 24, cwd, shell } = opts;
  const shellPath = shell || defaultShell();

  let proc;
  try {
    proc = pty.spawn(shellPath, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    });
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }

  ptys.set(id, proc);
  const wc = event.sender;

  proc.onData((data) => {
    if (!wc.isDestroyed()) wc.send('pty-data', { id, data });
  });
  proc.onExit(({ exitCode }) => {
    if (!wc.isDestroyed()) wc.send('pty-exit', { id, exitCode });
    ptys.delete(id);
  });

  return { ok: true, id, shell: shellPath, pid: proc.pid };
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

// Install a tool from the first-launch wizard, streaming output back to the renderer.
ipcMain.handle('install-tool', (event, { id, command }) => new Promise((resolve) => {
  const p = spawn(loginShell(), ['-lc', command]);
  const send = (chunk) => { if (!event.sender.isDestroyed()) event.sender.send('install-output', { id, chunk }); };
  p.stdout.on('data', (d) => send(d.toString()));
  p.stderr.on('data', (d) => send(d.toString()));
  p.on('close', (code) => resolve({ ok: code === 0, code }));
  p.on('error', (err) => { send('\n' + String(err.message) + '\n'); resolve({ ok: false, error: String(err.message) }); });
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
    { role: 'appMenu' },
    {
      label: 'Terminal',
      submenu: [
        { label: 'New Terminal', accelerator: 'CmdOrCtrl+N', click: () => sendToFocused('new-terminal') },
        { label: 'New Terminal (⌘T)', accelerator: 'CmdOrCtrl+T', click: () => sendToFocused('new-terminal') },
        { label: 'Close Terminal', accelerator: 'CmdOrCtrl+W', click: () => sendToFocused('close-terminal') },
        { label: 'Reopen Closed Terminal', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendToFocused('reopen-closed') },
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
    { role: 'editMenu' },
    { role: 'viewMenu' },
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

app.whenReady().then(() => {
  // Allow microphone for voice mode (local, trusted app).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(true);
  });

  buildMenu();
  createWindow(screen.getPrimaryDisplay(), 'primary');

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
