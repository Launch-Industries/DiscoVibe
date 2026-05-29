# TileTerm

A tiling, multi-session terminal for macOS, built with Electron + xterm.js + node-pty.

Open as many real shell sessions as you want; TileTerm lays them out **evenly across
the whole display** — 1 pane = full screen, 2 = halves, 3 = thirds, 4 = quarters, and
balanced rows beyond that so panes never get unusably thin. Each pane can be a different
**color** (the text color adapts automatically for readability), shows its **name**
prominently, and **flashes + chimes** when a tool inside it (like Claude Code) is waiting
on you.

## Run / build

```bash
cd ~/Developer/tile-term
npm install            # installs deps + rebuilds node-pty for Electron
npm start              # run in dev
npm run pack           # build dist/mac-arm64/TileTerm.app (unsigned, --dir)
npm run dist           # build a .dmg + .zip (unsigned)
```

The packaged app is installed at **`/Applications/TileTerm.app`** — launch it from
Spotlight or Launchpad. (It's unsigned; if macOS ever blocks it, right-click → Open once,
or run `xattr -dr com.apple.quarantine /Applications/TileTerm.app`.)

To redeploy after a code change:

```bash
cd ~/Developer/tile-term
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack
rm -rf /Applications/TileTerm.app && cp -R dist/mac-arm64/TileTerm.app /Applications/
xattr -dr com.apple.quarantine /Applications/TileTerm.app
```

## Using it

| Action | How |
| --- | --- |
| New terminal | `＋ New terminal` button, or **⌘T** |
| Close a terminal | the `✕` on the pane, or **⌘W** for the focused one |
| Rename a pane | click its name in the header and type |
| Change pane color | click the color swatch in the header (text recolors automatically) |
| Mute/unmute the chime globally | `🔔 Bell on` toolbar button, or **⌘M** |
| Turn the bell off for one pane | the `🔔` button in that pane's header |
| Move the window | drag the top toolbar |

### The attention bell

When a CLI tool needs your input it emits the terminal bell (`BEL` / `\x07`) — Claude Code
does this when it's waiting for you to approve or answer something. TileTerm catches that and:

- the pane **border pulses** yellow with a `● waiting on you` badge until you click into it
- a soft two-note **chime** plays (repeats a few times, then stops nagging but keeps flashing)

Clicking or typing in the pane acknowledges it and stops the alert. Mute silences the sound
but keeps the visual flash.

## Architecture

- **main.js** — Electron main process. Owns one `node-pty` shell per pane, bridged to the
  renderer over IPC (`pty-spawn` / `pty-input` / `pty-data` / `pty-resize` / `pty-kill`).
- **preload.js** — context-isolated bridge exposing `window.api`.
- **renderer/** — the UI. `renderer.js` manages panes, the even-tiling layout
  (`rowCountsFor`), per-pane color + adaptive contrast (WCAG luminance), and the bell
  (xterm `onBell` → CSS flash + Web Audio chime).

Set `TILETERM_DEBUG=1 npm start` to open DevTools and stream renderer console to the terminal.
