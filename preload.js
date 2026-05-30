'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Resolve a dropped File to its absolute path (Electron 32+ removed File.path).
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return (file && file.path) || ''; } },

  // PTY
  spawn: (opts) => ipcRenderer.invoke('pty-spawn', opts),
  input: (id, data) => ipcRenderer.send('pty-input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty-resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty-kill', { id }),
  onData: (cb) => ipcRenderer.on('pty-data', (_e, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('pty-exit', (_e, payload) => cb(payload)),

  // Menu
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),

  // Save terminal output
  saveOutput: (name, text) => ipcRenderer.invoke('save-output', { name, text }),

  // Companion browser / folders
  pickFile: () => ipcRenderer.invoke('pick-file'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  // Usage bar + first-launch installer
  runUsage: (command) => ipcRenderer.invoke('run-usage', { command }),
  installTool: (id, command) => ipcRenderer.invoke('install-tool', { id, command }),
  onInstallOutput: (cb) => ipcRenderer.on('install-output', (_e, payload) => cb(payload)),

  // Displays / multi-window
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  spanDisplays: () => ipcRenderer.invoke('span-displays'),
  onDisplays: (cb) => ipcRenderer.on('displays-changed', () => cb()),

  // Open a URL in the default system browser
  openExternal: (url) => ipcRenderer.send('open-external', { url }),

  // Cross-window broadcast (global settings)
  broadcast: (payload) => ipcRenderer.send('broadcast', payload),
  onBroadcast: (cb) => ipcRenderer.on('broadcast', (_e, payload) => cb(payload))
});
