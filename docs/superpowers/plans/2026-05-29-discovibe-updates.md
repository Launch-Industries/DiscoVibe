# DiscoVibe Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship six independent improvements to DiscoVibe: file insert (drag + picker), OS-level terminal bell, active/inactive pane color scheme, Claude action buttons, Shift+Tab keybinding fix, and removal of the Claude usage display from the primary window.

**Architecture:** All changes are in five plain-JS source files: `main.js` (Electron main process), `preload.js` (context bridge), `renderer/renderer.js` (all UI logic), `renderer/index.html` (HTML + pane template), `renderer/styles.css`. No bundler — edits go directly to source files.

**Tech Stack:** Electron, xterm.js (`@xterm/xterm`), Lucide icons (UMD), node-pty, vanilla JS/CSS.

> ⚠️ **STOP BEFORE REBUILDING:** Each task's verification step requires running the built app. Do not run `npm run build` (or equivalent) until the user confirms they have closed DiscoVibe. Steps marked **[BUILD REQUIRED]** cannot be verified while the app is running.

---

## Source File Map

| File | What changes |
|---|---|
| `main.js` | Add `file:pick-for-terminal` IPC, add `bell:ring` IPC |
| `preload.js` | Expose `pickFileForTerminal`, `bellRing` on `window.api` |
| `renderer/index.html` | Add file-insert button to pane template; replace `note-btn` with 3 Claude buttons; hide usage element |
| `renderer/renderer.js` | File drop handlers, bell IPC call + audio fix, active-pane color logic, Claude button handlers, Shift+Tab fix, usage hide-for-primary |
| `renderer/styles.css` | Style file-insert button highlight, Claude buttons, active-pane white override |

---

## Task 1: Add `file:pick-for-terminal` IPC in `main.js`

**Files:**
- Modify: `main.js` (add after the existing `pick-folder` handler, around line 185)

- [ ] **Step 1: Add the IPC handler**

  In `main.js`, after the `ipcMain.handle('pick-folder', ...)` block (line ~185), add:

  ```js
  // Multi-select file picker — inserts paths into the terminal input, not the browser.
  ipcMain.handle('file:pick-for-terminal', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Insert file path(s)',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'All Files', extensions: ['*'] }]
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false };
    return { ok: true, paths: filePaths };
  });
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add main.js
  git commit -m "feat: add file:pick-for-terminal IPC handler"
  ```

---

## Task 2: Add `bell:ring` IPC in `main.js`

**Files:**
- Modify: `main.js` (add after the new `file:pick-for-terminal` handler)

- [ ] **Step 1: Add the IPC handler**

  In `main.js`, after Task 1's new handler, add:

  ```js
  // OS-level bell: bounce the Dock icon when app is in background.
  ipcMain.on('bell:ring', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isFocused()) {
      app.dock.bounce('informational');
      win.flashFrame(true);
    }
  });
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add main.js
  git commit -m "feat: add bell:ring IPC for Dock bounce + window flash"
  ```

---

## Task 3: Expose new APIs in `preload.js`

**Files:**
- Modify: `preload.js`

- [ ] **Step 1: Add new `window.api` methods**

  In `preload.js`, inside the `contextBridge.exposeInMainWorld('api', { ... })` block, add after the `onBroadcast` entry:

  ```js
  // File insert
  pickFileForTerminal: () => ipcRenderer.invoke('file:pick-for-terminal'),

  // OS bell
  bellRing: () => ipcRenderer.send('bell:ring'),
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add preload.js
  git commit -m "feat: expose pickFileForTerminal and bellRing on window.api"
  ```

---

## Task 4: Update pane template in `renderer/index.html`

**Files:**
- Modify: `renderer/index.html`

- [ ] **Step 1: Replace `note-btn` with three Claude buttons + add file-insert button**

  In `renderer/index.html`, inside `<template id="pane-template">`, find the pane-header section and replace the `note-btn` line and add `file-insert-btn`:

  **Find:**
  ```html
        <button class="pane-btn note-btn" title="What are you working on? (saved with this window)"><i data-lucide="sticky-note"></i></button>
  ```

  **Replace with:**
  ```html
        <button class="pane-btn file-insert-btn" title="Insert file path(s) at cursor"><i data-lucide="file-plus"></i></button>
        <button class="pane-btn memory-btn" title="Save project to memory (/memory)"><i data-lucide="brain"></i></button>
        <button class="pane-btn clear-btn" title="Clear context (/clear)"><i data-lucide="eraser"></i></button>
        <button class="pane-btn compact-btn" title="Compact conversation (/compact)"><i data-lucide="minimize"></i></button>
  ```

- [ ] **Step 2: Verify usage bar is still hidden by default**

  Confirm `<span id="usage-readout" ... hidden>` still has `hidden` attribute in the toolbar (line ~16). No change needed — JS will control visibility.

- [ ] **Step 3: Commit**

  ```bash
  git add renderer/index.html
  git commit -m "feat: replace sticky-note button with file-insert + 3 Claude action buttons"
  ```

---

## Task 5: Wire up new pane buttons + file drop in `renderer/renderer.js`

**Files:**
- Modify: `renderer/renderer.js`

- [ ] **Step 1: Remove `noteBtn` reference, add new button references in `createPane()`**

  In `createPane()` (around line 374), find the block that destructures elements from `node`:

  **Find:**
  ```js
    const noteBtn = node.querySelector('.note-btn');
  ```

  **Replace with:**
  ```js
    const fileInsertBtn = node.querySelector('.file-insert-btn');
    const memoryBtn = node.querySelector('.memory-btn');
    const clearBtn = node.querySelector('.clear-btn');
    const compactBtn = node.querySelector('.compact-btn');
  ```

- [ ] **Step 2: Remove `noteBtn` from the pane object literal**

  Find:
  ```js
    const pane = {
      id, name, color, term, fitAddon,
      el: node, headerEl, bodyEl, termLayer, nameInput, colorInput, swatchBtn,
      webview, webUrlInput, webMode: false, webUrl: opts.webUrl || '',
      bellOn: opts.bellOn !== false,
      note: opts.note || '', manualName: opts.manual !== undefined ? !!opts.manual : !!opts.name, noteBtn,
  ```

  Replace with:
  ```js
    const pane = {
      id, name, color, term, fitAddon,
      el: node, headerEl, bodyEl, termLayer, nameInput, colorInput, swatchBtn,
      webview, webUrlInput, webMode: false, webUrl: opts.webUrl || '',
      bellOn: opts.bellOn !== false,
      manualName: opts.manual !== undefined ? !!opts.manual : !!opts.name,
  ```

- [ ] **Step 3: Remove `noteBtn` setup code**

  Find and delete these lines (around line 524–527):
  ```js
    // Per-window note ("what I'm working on") — saved with the session
    noteBtn.classList.toggle('has-note', !!pane.note);
    noteBtn.addEventListener('click', () => openNotePopover(pane, noteBtn));
  ```

- [ ] **Step 4: Wire up file-insert button**

  After the `collapseBtn.addEventListener` line (around line 541), add:

  ```js
    // File insert button
    fileInsertBtn.addEventListener('click', async () => {
      const r = await window.api.pickFileForTerminal();
      if (r && r.ok && r.paths.length) {
        window.api.input(id, r.paths.join(' '));
        term.focus();
      }
    });

    // Claude action buttons
    memoryBtn.addEventListener('click', () => { window.api.input(id, '/memory\r'); term.focus(); });
    clearBtn.addEventListener('click', () => { window.api.input(id, '/clear\r'); term.focus(); });
    compactBtn.addEventListener('click', () => { window.api.input(id, '/compact\r'); term.focus(); });
  ```

- [ ] **Step 5: Add file drag-and-drop on pane body**

  After the pane-reorder `drop` handler (around line 563), add drag-and-drop for files:

  ```js
    // File drag-and-drop: when not a pane reorder, insert file paths at cursor
    node.addEventListener('dragover', (e) => {
      if (dragSrcId) return;   // pane reorder takes priority
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        node.classList.add('file-drop-target');
      }
    });
    node.addEventListener('dragleave', () => node.classList.remove('file-drop-target'));
    node.addEventListener('drop', async (e) => {
      node.classList.remove('file-drop-target');
      if (dragSrcId || !e.dataTransfer.files.length) return;
      e.preventDefault();
      const paths = Array.from(e.dataTransfer.files).map((f) => f.path);
      if (paths.length) { window.api.input(id, paths.join(' ')); term.focus(); }
    });
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add renderer/renderer.js
  git commit -m "feat: wire file-insert button, file drag-drop, and Claude action buttons"
  ```

---

## Task 6: Fix terminal bell — AudioContext + OS notification

**Files:**
- Modify: `renderer/renderer.js`

- [ ] **Step 1: Call `ensureAudio()` on user interaction**

  In `createPane()`, find the `acknowledge` function (around line 506):

  ```js
    const acknowledge = () => { setFocused(id); clearAttention(pane); pane.lastActivity = Date.now(); };
  ```

  Replace with:
  ```js
    const acknowledge = () => { ensureAudio(); setFocused(id); clearAttention(pane); pane.lastActivity = Date.now(); };
  ```

- [ ] **Step 2: Add OS-level bell call in `triggerAttention()`**

  Find `triggerAttention` (around line 236):

  ```js
  function triggerAttention(pane) {
    if (!alertsEnabled || !pane.bellOn) return;
    pane.el.classList.add('attn');
    if (!pane.attnTimer) {
  ```

  Replace with:
  ```js
  function triggerAttention(pane) {
    if (!alertsEnabled || !pane.bellOn) return;
    pane.el.classList.add('attn');
    window.api.bellRing();
    if (!pane.attnTimer) {
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add renderer/renderer.js
  git commit -m "fix: AudioContext unlock on user gesture + OS Dock bounce on bell"
  ```

---

## Task 7: Active-pane white color scheme

**Files:**
- Modify: `renderer/renderer.js`

- [ ] **Step 1: Add `whiteActivePane` to `settings` object**

  Find the `settings` object (line 24):

  ```js
  const settings = {
    autoCollapse: true,
  ```

  Add `whiteActivePane: true,` and `globalActiveColor: '#ffffff',` and `globalInactiveColor: '',` after `showModel`:

  ```js
  const settings = {
    autoCollapse: true,
    autoCollapseMin: 30,
    dimInactive: false,
    dimLevel: 0.5,
    tabSwitch: false,
    disco: false,
    clickToMove: true,
    autoName: true,
    usageEnabled: true,
    usageCommand: CLAUDE_USAGE_CMD,
    usageIntervalSec: 30,
    projectsDir: '',
    openInApp: true,
    nameFromTitle: true,
    showModel: true,
    whiteActivePane: true,      // active pane → white bg + black text
    globalColorMode: false,     // true = all inactive panes share one color
    globalActiveColor: '#ffffff',
    globalInactiveColor: '#10131a'
  };
  ```

- [ ] **Step 2: Track `tileColor` separately on pane object**

  In `createPane()`, find:
  ```js
    const pane = {
      id, name, color, term, fitAddon,
  ```

  Add `tileColor: color,` to the pane object:
  ```js
    const pane = {
      id, name, color, tileColor: color, term, fitAddon,
  ```

- [ ] **Step 3: Keep `tileColor` in sync when user picks a color**

  Find the color input listener (around line 530):
  ```js
    colorInput.addEventListener('input', () => { applyColor(pane, colorInput.value); scheduleSave(); });
  ```

  Replace with:
  ```js
    colorInput.addEventListener('input', () => {
      pane.tileColor = toHex6(colorInput.value);
      applyColor(pane, pane.id === focusedId && settings.whiteActivePane ? settings.globalActiveColor : pane.tileColor);
      scheduleSave();
    });
  ```

  Also update the swatch popover click handler in `openColorPopover` (around line 912):
  ```js
    sw.addEventListener('click', () => { applyColor(pane, col); scheduleSave(); closePopover(); });
  ```
  Replace with:
  ```js
    sw.addEventListener('click', () => {
      pane.tileColor = toHex6(col);
      applyColor(pane, pane.id === focusedId && settings.whiteActivePane ? settings.globalActiveColor : pane.tileColor);
      scheduleSave(); closePopover();
    });
  ```

- [ ] **Step 4: Update `setFocused()` to apply white-active color**

  Find `setFocused` (around line 636):
  ```js
  function setFocused(id) {
    focusedId = id;
    for (const p of panes) p.el.classList.toggle('focused', p.id === id);
  }
  ```

  Replace with:
  ```js
  function setFocused(id) {
    focusedId = id;
    for (const p of panes) {
      p.el.classList.toggle('focused', p.id === id);
      if (settings.whiteActivePane) {
        const displayColor = p.id === id
          ? (settings.globalColorMode ? settings.globalActiveColor : '#ffffff')
          : (settings.globalColorMode ? settings.globalInactiveColor : p.tileColor);
        applyColor(p, displayColor);
      }
    }
  }
  ```

- [ ] **Step 5: Add toggle to Quick settings popover in `openGlobalSettings()`**

  Find in `openGlobalSettings` (around line 938):
  ```js
    c.appendChild(checkRow('Disco mode ✨', () => settings.disco, (v) => { settings.disco = v; settingsChanged(); }));
  ```

  Add after that line:
  ```js
    c.appendChild(checkRow('White active pane', () => settings.whiteActivePane, (v) => {
      settings.whiteActivePane = v;
      settingsChanged();
      // Re-apply colors immediately
      for (const p of [...panes, ...stored]) {
        applyColor(p, p.id === focusedId && v ? '#ffffff' : p.tileColor);
      }
    }));
    c.appendChild(checkRow('Global color mode (all inactive same color)', () => settings.globalColorMode, (v) => {
      settings.globalColorMode = v; settingsChanged();
      for (const p of panes) {
        const col = p.id === focusedId && settings.whiteActivePane ? '#ffffff'
          : (v ? settings.globalInactiveColor : p.tileColor);
        applyColor(p, col);
      }
    }));
  ```

- [ ] **Step 6: Commit**

  ```bash
  git add renderer/renderer.js
  git commit -m "feat: white active pane + per-pane vs global inactive color scheme"
  ```

---

## Task 8: Fix Shift+Tab keybinding

**Files:**
- Modify: `renderer/renderer.js`

- [ ] **Step 1: Update the custom key handler in `createPane()`**

  Find in `createPane()` (around line 499):
  ```js
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || e.key !== 'Tab') return true;
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
      if (e.ctrlKey || (settings.tabSwitch && plain)) { cyclePane(e.shiftKey ? -1 : 1); return false; }
      return true;
    });
  ```

  Replace with:
  ```js
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || e.key !== 'Tab') return true;
      // Ctrl+Tab / Ctrl+Shift+Tab: always cycle panes
      if (e.ctrlKey && !e.altKey && !e.metaKey) { cyclePane(e.shiftKey ? -1 : 1); return false; }
      // Plain Tab (no modifiers at all): cycle forward only if tabSwitch setting is on
      // Shift+Tab is intentionally excluded so it remains available for system shortcuts
      const plainForward = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if (settings.tabSwitch && plainForward) { cyclePane(1); return false; }
      return true;
    });
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add renderer/renderer.js
  git commit -m "fix: exclude Shift+Tab from pane cycling so it reaches system shortcuts"
  ```

---

## Task 9: Hide usage bar in primary window

**Files:**
- Modify: `renderer/renderer.js`

- [ ] **Step 1: Add primary-window guard to `pollUsage()`**

  Find `pollUsage` (around line 1548):
  ```js
  async function pollUsage(force) {
    if (!settings.usageEnabled || !settings.usageCommand) { usageEl.hidden = true; return; }
  ```

  Replace with:
  ```js
  async function pollUsage(force) {
    if (ROLE === 'primary' || !settings.usageEnabled || !settings.usageCommand) { usageEl.hidden = true; return; }
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add renderer/renderer.js
  git commit -m "fix: hide Claude usage bar in primary window"
  ```

---

## Task 10: Add CSS for file-drop highlight and Claude buttons

**Files:**
- Modify: `renderer/styles.css`

- [ ] **Step 1: View existing `.pane` and `.pane-btn` styles to understand class conventions**

  Read `renderer/styles.css` to confirm class naming patterns before adding new rules.

- [ ] **Step 2: Add file-drop target highlight**

  Append to `renderer/styles.css`:

  ```css
  /* File drop target — visual feedback when dragging files over a pane */
  .pane.file-drop-target {
    outline: 2px solid rgba(255, 255, 255, 0.7);
    outline-offset: -2px;
  }
  .pane.file-drop-target .pane-header {
    opacity: 0.85;
  }
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add renderer/styles.css
  git commit -m "style: file-drop highlight and Claude action button appearance"
  ```

---

## Task 11: Remove `note` from session persistence (cleanup)

**Files:**
- Modify: `renderer/renderer.js`

The `note` field was serialized in the session. Since we removed the note feature, clean it up.

- [ ] **Step 1: Remove `note` from `paneConfig()`**

  Find (around line 1260):
  ```js
  function paneConfig(p, collapsed) {
    return { name: p.nameInput.value || p.name, color: p.color, bellOn: p.bellOn,
      webUrl: p.webUrl || '', note: p.note || '', manual: !!p.manualName, collapsed: !!collapsed };
  }
  ```

  Replace with:
  ```js
  function paneConfig(p, collapsed) {
    return { name: p.nameInput.value || p.name, color: p.tileColor || p.color, bellOn: p.bellOn,
      webUrl: p.webUrl || '', manual: !!p.manualName, collapsed: !!collapsed };
  }
  ```

  Note: also switched `color` to `tileColor` so the saved color is the resting tile color (not the transient white active color).

- [ ] **Step 2: Remove `note` from `createPane()` opts**

  Find in `createPane()`:
  ```js
    bellOn: opts.bellOn !== false,
    note: opts.note || '', manualName: opts.manual !== undefined ? !!opts.manual : !!opts.name, noteBtn,
  ```

  (This was already updated in Task 5 Step 2 — verify it has no `note` field.)

- [ ] **Step 3: Remove `openNotePopover` function**

  Find and delete the entire `openNotePopover` function (around line 798–813):
  ```js
  function openNotePopover(pane, anchor) {
    ...
  }
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add renderer/renderer.js
  git commit -m "refactor: remove note feature, save tileColor in session"
  ```

---

## Task 12: Build, install, and verify **[BUILD REQUIRED — close DiscoVibe first]**

> ⚠️ This task requires quitting DiscoVibe before running. Coordinate with the user.

- [ ] **Step 1: Confirm build command**

  Check the `package.json` in the SOURCE directory (not inside the asar) for the build script:
  ```bash
  cat package.json | grep -A5 '"scripts"'
  ```

- [ ] **Step 2: Install dependencies if needed**

  ```bash
  npm install
  ```

- [ ] **Step 3: Build the app**

  ```bash
  npm run build
  # or: npx electron-builder build --mac --arm64
  ```

- [ ] **Step 4: Install the new build**

  Drag the new `.app` from `dist/` (or wherever the build lands) to `/Applications`, replacing the previous version.

- [ ] **Step 5: Verify — File Insert**

  - Open DiscoVibe, drag a file from Finder onto a terminal pane
  - Expected: file path appears at cursor, pane highlights with outline on dragover
  - Open DiscoVibe, click the file-plus button in any pane header
  - Expected: native file picker opens; selecting files inserts space-separated paths

- [ ] **Step 6: Verify — Terminal Bell**

  - In a terminal, run: `printf '\a'`
  - Expected: chime plays AND if app is backgrounded, Dock icon bounces

- [ ] **Step 7: Verify — Active-pane Color**

  - Open 2+ panes
  - Expected: focused pane = white background with black text; others = distinct dark colors with white text
  - Click another pane — colors swap accordingly

- [ ] **Step 8: Verify — Claude Action Buttons**

  - Open a Claude Code session in a pane
  - Click the brain button → `/memory\r` sent to pty
  - Click the eraser button → `/clear\r` sent
  - Click the minimize button → `/compact\r` sent

- [ ] **Step 9: Verify — Shift+Tab fixed**

  - In any pane, press Shift+Tab
  - Expected: NOT cycle to previous pane; keypress passes through to the shell
  - Cmd+[ should still cycle to previous pane (via menu shortcut)

- [ ] **Step 10: Verify — Usage bar hidden in primary window**

  - Primary window: usage bar should not appear
  - (If a secondary window is open: usage bar may appear there if enabled in settings)

---

## Implementation Notes

- **Session data migration:** Saved sessions include `note` fields — they'll be silently ignored on load since `createPane()` no longer uses them. No migration needed.
- **`tileColor` on stored panes:** When a pane is restored from a collapsed state, it may briefly show white before `setFocused` is called. If noticeable, call `applyColor(pane, pane.tileColor)` at the end of `restorePane()`.
- **`audioCtx` on first bell:** Even with `ensureAudio()` on acknowledge, the AudioContext may be blocked until the first explicit user gesture in the window. This is a browser security requirement that cannot be fully bypassed — the first bell after launch may silently fail. Subsequent bells work.
- **Cmd+[ / Cmd+] already wired:** The menu in `main.js` already has `CmdOrCtrl+[` for prev and `CmdOrCtrl+]` for next (lines ~230–235 in main.js). No main.js change needed for keybindings.
- **Swatch chip shows white on active pane:** `applyColor` updates `--swatch-fill` to the displayed color. When a pane is active (white), its swatch chip will appear white. This is cosmetic — the real tile color is safely stored in `pane.tileColor` and restored when the pane loses focus. Can be improved later by reading `pane.tileColor` for the swatch fill instead of the display color.
