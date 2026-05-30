# DiscoVibe Updates — Design Spec
Date: 2026-05-29

## Overview

Six updates to DiscoVibe, a tiling multi-session terminal for macOS (Electron). All changes are independent and can be implemented in any order.

---

## 1. File Insert — Drag & Drop + Picker

### Goal
Allow users to insert file paths into the active terminal input by dragging files onto a pane or using a file picker button.

### Behavior
- Dropping one or more files onto a terminal pane inserts their absolute paths, space-separated, at the cursor position.
- A small file icon button in each pane header opens a native file picker (multi-select enabled); selecting files produces the same space-separated path insertion.
- During a drag-over, the target pane displays a subtle highlight border to indicate it's a valid drop target.

### Architecture
- **Main process:** A `fileInsert` module registers two IPC handlers:
  - `file:pick` — calls `dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })`, returns array of absolute paths.
  - `file:drop` — receives an array of paths already extracted by the renderer, returns them joined with spaces.
- **Renderer:** Each pane registers `dragover` and `drop` DOM event listeners. On `dragover`, applies a CSS highlight class. On `drop`, extracts `event.dataTransfer.files`, sends paths via `file:drop` IPC, receives the formatted string, and writes it to the pty input. The pane header file icon button sends `file:pick` IPC and handles the response the same way.
- Path formatting (join with spaces) lives in the main process so both flows share the same logic.

---

## 2. Terminal Bell

### Goal
Play an audible alert and flash the window when a BEL character is received in terminal output, so users can see when Claude (or any process) is waiting for input.

### Behavior
- When the terminal emulator receives `\x07` (BEL):
  - Play the macOS system alert sound.
  - If DiscoVibe is in the background: flash the window via `BrowserWindow.flashFrame(true)` and bounce the Dock icon via `app.dock.bounce('informational')`.
  - If DiscoVibe is in the foreground: sound only, no flash.

### Architecture
- The renderer's terminal data handler checks for `\x07` in output stream.
- On BEL detection, sends an IPC message `bell:ring` to the main process.
- Main process handler plays the system sound (`shell.beep()` or equivalent) and calls `flashFrame` / `dock.bounce` if the window is not focused.

---

## 3. Pane Color Scheme + ANSI Contrast

### Goal
Make the active pane visually distinct from inactive panes, and ensure text is always readable regardless of background color.

### Behavior
**Per-pane mode (default):**
- Active pane: white background, black text.
- Each inactive pane gets a distinct color from a curated dark palette (dark blue, dark teal, dark plum, dark forest, etc.) with white text. Colors cycle across panes.

**Global mode (optional):**
- User sets one color for the active pane and one color for all inactive panes via settings.
- Toggle between modes in the settings panel.

**ANSI contrast:**
- ANSI colors are remapped per-pane so they meet minimum contrast ratios against that pane's background color.
- This applies in both per-pane and global modes.

### Architecture
- A `colorScheme` settings key stores `{ mode: 'per-pane' | 'global', globalActive: string, globalInactive: string }`.
- A `paneColorManager` module computes the background/foreground color for each pane based on its index and the current mode.
- Each pane receives its color theme and applies it as CSS custom properties.
- ANSI color remapping is computed against the pane's background at render time using contrast ratio calculations (WCAG AA minimum: 4.5:1).

---

## 4. Claude Action Buttons

### Goal
Replace the sticky note button with three one-click buttons that send common Claude Code commands to the active pane's session.

### Buttons
| Button | Command sent to pty | Tooltip |
|---|---|---|
| Save to Memory | `/memory` | Save project to memory |
| Clear Context | `/clear` | Clear context |
| Compact | `/compact` | Compact conversation |

### Behavior
- Buttons live in each pane's header, in the same location as the sticky note button.
- Clicking a button writes the corresponding command string + newline directly to that pane's pty input.
- Buttons are small icon buttons with tooltips on hover.

### Architecture
- Remove sticky note button component.
- Add three icon button components in the pane header.
- Each button's `onClick` calls a shared `sendToPty(paneId, command)` utility that writes to the pty.

---

## 5. Keybinding Change — Previous/Next Pane

### Goal
Free up `Shift+Tab` (currently used for "previous pane") so it is available for system and app shortcuts like Claude Code's mode toggle.

### Change
| Action | Old binding | New binding |
|---|---|---|
| Previous pane | `Shift+Tab` | `Cmd+[` |
| Next pane | retain existing binding | `Cmd+]` |

### Architecture
- Update the default keybinding config for pane navigation.
- `Cmd+[` / `Cmd+]` follow macOS conventions (used by iTerm2, browsers, Xcode for prev/next tab).

---

## 6. Remove Claude Usage Display

### Goal
Remove the Claude usage display from the top of the primary window to declutter the UI.

### Change
- Remove the Claude usage component from the primary window's top bar.
- Remove the component and reclaim the vertical space in the primary window top bar.

### Architecture
- Delete or conditionally hide the usage display component.
- No data or IPC changes required.

---

## Out of Scope
- Configurable keybinding UI (users cannot remap keys beyond the global/per-pane color toggle)
- File previews or file content insertion (path-only)
- Custom bell sounds
