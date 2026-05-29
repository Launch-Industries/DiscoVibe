'use strict';

const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('path');
const os = require('os');
const pty = require('node-pty');

// Map of paneId -> pty process
const ptys = new Map();

let mainWindow = null;

function defaultShell() {
  if (os.platform() === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  mainWindow = new BrowserWindow({
    width,
    height,
    x: display.workArea.x,
    y: display.workArea.y,
    title: 'TileTerm',
    backgroundColor: '#0b0e14',
    titleBarStyle: 'hiddenInset', // keeps native traffic lights, gives us the full canvas
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.maximize();

  if (process.env.TILETERM_DEBUG) {
    const wc = mainWindow.webContents;
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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

// ---- App lifecycle ----------------------------------------------------------

function buildMenu() {
  // Minimal menu so Cmd+C/V/Q and devtools still work; pane actions are in-window.
  const template = [
    { role: 'appMenu' },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'New Terminal',
          accelerator: 'CmdOrCtrl+T',
          click: () => mainWindow && mainWindow.webContents.send('menu', 'new-terminal')
        },
        {
          label: 'Close Terminal',
          accelerator: 'CmdOrCtrl+W',
          click: () => mainWindow && mainWindow.webContents.send('menu', 'close-terminal')
        },
        { type: 'separator' },
        {
          label: 'Toggle Mute Bell',
          accelerator: 'CmdOrCtrl+M',
          click: () => mainWindow && mainWindow.webContents.send('menu', 'toggle-mute')
        }
      ]
    },
    { role: 'editMenu' },
    {
      role: 'viewMenu'
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  ptys.forEach((p) => { try { p.kill(); } catch (_) {} });
  ptys.clear();
  app.quit();
});
