# DiscoVibe

**A tiling, multi-session terminal built for vibe-coders** — macOS, Electron + xterm.js + node-pty.

Created by **[Monica Colgan](https://launchindustries.biz)** at **[Launch Industries LLC](https://launchindustries.biz)**.

Open as many real shell sessions as you want; DiscoVibe tiles them evenly across the whole display (and across all your monitors). Every pane has its own color, a prominent name, always-legible text, and a flash-and-chime **attention bell** for when an AI tool is waiting on you.

---

## Quick start

```bash
# Install from /Applications/DiscoVibe.app (built release)
# Or run from source:
cd ~/Developer/discovibe
npm install          # deps + rebuilds node-pty for Electron
npm start            # run in dev mode
```

Launch from Spotlight / Launchpad. If macOS blocks it (unsigned build), right-click → Open once.

---

## What's inside

### Terminals
- **Even tiling** — 1 = full screen, 2 = halves, 3 = thirds, 4 = side-by-side; balanced rows beyond 4
- **Multi-monitor** — ⌘D opens a window on every display, each filling its screen and tiling independently
- **Per-pane color + guaranteed legibility** — WCAG ≥4.5:1 contrast enforced on every background
- **Drag files from Finder** → shell-escaped path inserted at cursor
- **Drag-and-drop reorder** — drag a pane by its grip handle
- **Collapse / store panes** — park a running terminal in the tray, restore it any time
- **Auto-collapse** — idle panes collapse after a configurable timeout (default 30 min)
- **Dim inactive panes** — focus mode that darkens everything except the active pane

### AI-optimized
- **AI tool commands panel** — per-system dropdowns for Claude Code, Codex, Aider, Kiro, Gemini, Vercel; one click to launch, install, compact, clear, review, and more
- **Attention bell** — BEL character (`\x07`) flashes the pane border + plays a chime; ignores bells fired within 2 s of a keypress (shell feedback, Claude mode-switch) so only real AI waits trigger it
- **Auto-name terminals from AI activity** — detects Claude / Codex / Gemini output and renames the pane header accordingly
- **Show AI model in header** — Opus / Sonnet / Haiku badge auto-detected from output

### Productivity
- **Quick commands** — My Commands list plus pre-built AI prompts: *What are we working on?*, *Remember this*, *Resume later*
- **Saved layouts** — save and restore named layouts across restarts
- **Tile themes** — Galaxy, Pacific Northwest, Desert, Iceland, Ocean, Sunlight, Aurora Borealis, and Pride / heritage flag themes
- **Voice mode** 🎙 — speak commands into the focused terminal (Groq Whisper by default; macOS Dictation fallback)
- **Clipboard history** — last 10 copies, one click to paste into the focused terminal
- **Usage bar** — live Claude token usage in the toolbar (configurable shell command)

### Setup
- **Projects folder** — pick your root folder on first launch; new terminals open there automatically

### Keyboard shortcuts

| Action | Shortcut |
|---|---|
| New terminal | ⌘T or ⌘N |
| Close terminal | ⌘W |
| Clear terminal | ⌘K |
| Save output | ⌘S |
| Collapse / store | ⌘⇧S |
| Close all (killswitch) | ⌘⇧K |
| Cycle panes | Ctrl+Tab / Ctrl+Shift+Tab |
| Next / previous pane | ⌘] / ⌘[ |
| Span displays | ⌘D |
| Mute bell | ⌘M |
| Toggle alerts | ⌘E |
| Preferences | ⌘, |

---

## Build & deploy

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack   # → dist/mac-arm64/DiscoVibe.app (unsigned)

# Redeploy to /Applications:
rm -rf /Applications/DiscoVibe.app
cp -R dist/mac-arm64/DiscoVibe.app /Applications/
xattr -dr com.apple.quarantine /Applications/DiscoVibe.app
```

`TILETERM_DEBUG=1 npm start` opens DevTools and streams the renderer console.

---

## Architecture

| File | Responsibility |
|---|---|
| `main.js` | Electron main process: PTY management, IPC handlers, multi-window, display detection, mic permission, tool installer |
| `preload.js` | Context-isolated `window.api` bridge |
| `renderer/renderer.js` | All UI: pane lifecycle, tiling, color/contrast, bell, voice, popovers, drag-reorder, collapse tray, AI commands panel, quick commands, feedback form, persistence (localStorage) |
| `renderer/styles.css` | All styles — dark/light themes, pane layout, toolbar, popovers, accordion, tooltips |
| `renderer/index.html` | Shell + pane template + toolbar |

Icons: [Lucide](https://lucide.dev). Terminal engine: [xterm.js](https://xtermjs.org). PTY: [node-pty](https://github.com/microsoft/node-pty).

---

## Feedback

Questions or ideas? Email [dev@launchindustries.biz](mailto:dev@launchindustries.biz) or use the **message-circle icon** in the app toolbar to send feedback directly.

---

© 2025 [Launch Industries LLC](https://launchindustries.biz) — Monica Colgan
