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

  // Session transcripts (recover a closed terminal's output)
  listTranscripts: () => ipcRenderer.invoke('list-transcripts'),
  readTranscript: (base) => ipcRenderer.invoke('read-transcript', { base }),
  deleteTranscript: (base) => ipcRenderer.invoke('delete-transcript', { base }),
  revealTranscript: (base) => ipcRenderer.invoke('reveal-transcript', { base }),
  transcriptMeta: (id, patch) => ipcRenderer.send('transcript-meta', { id, patch }),
  claudeSessions: (cwd) => ipcRenderer.invoke('claude-sessions', { cwd }),

  // Companion browser / folders
  pickFile: () => ipcRenderer.invoke('pick-file'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  // Usage bar
  runUsage: (command) => ipcRenderer.invoke('run-usage', { command }),

  // Window naming
  projectName: (dir) => ipcRenderer.invoke('project-name', { dir }),
  setWindowTitle: (title) => ipcRenderer.send('set-window-title', { title }),

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
