# DiscoVibe

A tiling, multi-session terminal for macOS — built with Electron + xterm.js + node-pty.

Open as many real shell sessions as you want; DiscoVibe tiles them **evenly across the
whole display** (and across **all** your monitors). Every pane has its own color, a
prominent name, always-legible text, and a flash-and-chime **attention bell** for when a
tool inside it (like Claude Code) is waiting on you.

> The repo folder is `tile-term` for historical reasons; the product is **DiscoVibe**,
> installed at `/Applications/DiscoVibe.app`.

## Run / build / deploy

```bash
cd ~/Developer/tile-term
npm install                                  # deps + rebuilds node-pty for Electron
npm start                                    # run in dev
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack   # build dist/mac-arm64/DiscoVibe.app (unsigned)
# redeploy:
rm -rf /Applications/DiscoVibe.app && cp -R dist/mac-arm64/DiscoVibe.app /Applications/
xattr -dr com.apple.quarantine /Applications/DiscoVibe.app
```

Launch from Spotlight/Launchpad. It's unsigned; if macOS blocks it, right-click → Open once.
`TILETERM_DEBUG=1 npm start` opens DevTools and streams the renderer console.
Note: `timeout` isn't installed on this Mac — time-box a launch with `node -e "setTimeout(()=>process.exit(0),8000)"`.

## Features

- **Even tiling** — 1 = full screen, 2 = halves, 3 = thirds, 4 = quarters; balanced equal
  rows beyond 4 so panes never get unusably thin.
- **Multi-monitor** — *Span displays* (⌘D) opens a DiscoVibe window on every connected
  display, each filling its monitor and tiling independently. The toolbar shows the detected
  display count; hover it for each monitor's resolution.
- **Open many at once** — type a number next to *New terminal* and open that many (hard cap
  **30** terminals total).
- **Per-pane color + guaranteed legibility** — pick any background (preset palette or custom
  picker); the text color is chosen by **WCAG contrast ratio**, so every possible background
  stays readable (≥4.5:1). The color chip always has a contrasting border.
- **Tile themes** — Galaxy, Pacific Northwest, Desert, Iceland, Ocean, Sunlight. New
  terminals pull their colors from the chosen theme, and the **window frame** is tinted to
  match it.
- **Big, customizable, optionally-centered titles** — title size is global and syncs across
  every pane and window; each pane can center its title.
- **Terminal text zoom + font picker** — per-pane text size and typeface (in the ⚙ settings
  popover).
- **Drag-and-drop reorder** — drag a pane by its grip handle.
- **Collapse / store panes** — park a pane you're taking a break from; its shell keeps
  running and it waits in the bottom tray until you click it back. **Auto-collapse** idle
  panes after a configurable timeout (default 30 min).
- **Dim inactive panes** — optional focus mode that darkens every pane except the active one.
- **Voice mode** 🎙 — toggle to speak commands into the focused terminal (Web Speech API +
  macOS mic permission). If the speech backend is unavailable in this build, the button shows
  it; macOS Dictation is a guaranteed fallback.
- **Quick commands** — store your top 10 commands (e.g. `cd ~/Developer`) and one-click run
  them in the focused terminal.
- **Saved layouts** — your panes/colors/sizes/order are remembered between launches; save and
  re-apply **named** layouts from the *Layouts* popover.
- **Attention bell** — a tool emitting `BEL` (`\x07`) flashes the pane + chimes; global mute
  (⌘M) and per-pane bell toggle. (Test it: run `printf '\a'` in a pane.)
- **Dark / light mode** — toggles the app chrome; syncs across windows.
- **Disco mode ✨** — optional flair (rainbow-cycling window frame, spinning disco-ball logo);
  the wordmark always shimmers. Terminals are left untouched for readability.
- **Keyboard** — ⌘N / ⌘T new terminal, ⌘W close, ⌘⇧K close-all killswitch, ⌘S save output,
  ⌘K clear, ⌘⇧S collapse/store, ⌘] / ⌘[ next/prev, ⌘D span displays, ⌘M mute sound,
  ⌘E alerts on/off, **Ctrl+Tab / Ctrl+Shift+Tab** cycle panes (optional plain Tab/Shift+Tab
  in Settings — note it disables shell completion while on).

## Architecture

- **main.js** — Electron main: one `node-pty` shell per pane (bridged over IPC), multi-window
  management (one window per display), display detection, mic permission, cross-window
  broadcast for global settings.
- **preload.js** — context-isolated `window.api` bridge.
- **renderer/** — the UI. `renderer.js` owns panes, tiling, color/contrast, the bell, voice,
  popovers (settings / color / tiles / commands / layouts), drag-reorder, collapse tray, and
  persistence (localStorage). Icons are Lucide.
