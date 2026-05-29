'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  spawn: (opts) => ipcRenderer.invoke('pty-spawn', opts),
  input: (id, data) => ipcRenderer.send('pty-input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty-resize', { id, cols, rows }),
  kill: (id) => ipcRenderer.send('pty-kill', { id }),
  onData: (cb) => ipcRenderer.on('pty-data', (_e, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('pty-exit', (_e, payload) => cb(payload)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action))
});
