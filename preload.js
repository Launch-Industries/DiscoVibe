'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
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

  // Companion browser
  pickFile: () => ipcRenderer.invoke('pick-file'),

  // Displays / multi-window
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  spanDisplays: () => ipcRenderer.invoke('span-displays'),
  onDisplays: (cb) => ipcRenderer.on('displays-changed', () => cb()),

  // Cross-window broadcast (global settings)
  broadcast: (payload) => ipcRenderer.send('broadcast', payload),
  onBroadcast: (cb) => ipcRenderer.on('broadcast', (_e, payload) => cb(payload))
});
