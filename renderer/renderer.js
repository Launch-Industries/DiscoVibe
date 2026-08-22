'use strict';

/* global Terminal, FitAddon, WebLinksAddon */

// ===========================================================================
// State
// ===========================================================================
const panes = [];          // active (visible) panes, in tile order
const stored = [];         // collapsed panes (shells stay alive)
let paneCounter = 0;
let focusedId = null;
let soundMuted = false;
let alertsEnabled = true;   // master switch for flash + chime alerts
let themeMode = 'dark';
let globalTitleSize = 20;   // shared across ALL panes and windows
let globalFontSize = 13;    // terminal text size — global
let globalFontFamily = '';  // set after FONTS defined (DEFAULT_FONT)
let globalTitleCenter = false;

// Out-of-the-box Claude usage command: streams today's tokens from ~/.claude logs
// (jq per-line, summed by awk — low memory even with very large logs).
const CLAUDE_USAGE_CMD = "find ~/.claude/projects -name '*.jsonl' -mtime -1 -print0 2>/dev/null | xargs -0 cat 2>/dev/null | jq -rc --arg d \"$(date +%Y-%m-%d)\" 'select((.timestamp//\"\")[0:10]==$d) | (.message.usage // empty) | ((.input_tokens//0)+(.output_tokens//0)+(.cache_creation_input_tokens//0)+(.cache_read_input_tokens//0))' 2>/dev/null | awk '{s+=$1} END{ if(s>=1000000000) printf \"Claude today: %.1fB tok\\n\", s/1000000000; else if(s>=1000000) printf \"Claude today: %.1fM tok\\n\", s/1000000; else if(s>=1000) printf \"Claude today: %dK tok\\n\", s/1000; else printf \"Claude today: %d tok\\n\", s }'";

const settings = {
  autoCollapse: true,
  autoCollapseMin: 30,
  dimInactive: false,
  dimLevel: 0.5,             // brightness multiplier for inactive panes (lower = darker)
  tabSwitch: false,          // plain Tab/Shift+Tab switches panes
  disco: false,              // extra disco flair (rainbow frame, spinning ball)
  clickToMove: true,         // click in a pane to position the shell cursor
  autoName: true,            // AI-name terminals from their recent activity
  usageEnabled: true,        // show a usage bar from a polled command
  usageCommand: CLAUDE_USAGE_CMD,
  usageIntervalSec: 30,
  projectsDir: '',           // new terminals open here (e.g. ~/Developer)
  openInApp: true,           // open clicked links in the pane's companion browser
  nameFromTitle: true,       // rename a pane when a program sets the terminal title (OSC)
  showModel: true,           // show the detected AI model (Opus/Sonnet/…) in the header
  alertFocused: true         // also alert the pane you're working in when it waits on a prompt
};

// Optional AI clean-up of dictated speech (OpenAI-compatible endpoint, e.g. free Qwen on
// OpenRouter). Off until an API key is set; falls back to the raw transcript on any error.
const voiceAI = {
  // Speech-to-text (required for voice). Default = Groq Whisper (free tier).
  sttUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
  sttModel: 'whisper-large-v3',
  sttKey: '',
  // Optional clean-up of the transcript into a command (free Qwen on OpenRouter).
  enabled: false,
  baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
  model: 'qwen/qwen-2.5-coder-32b-instruct:free',
  apiKey: ''
};

// This window's identity + role (primary window restores the saved session).
const WIN_TAG = Math.random().toString(36).slice(2, 8);
const ROLE = new URLSearchParams(location.search).get('role') || 'primary';
const WIN_KEY = new URLSearchParams(location.search).get('key') || 'primary';

const MIN_TITLE = 12, MAX_TITLE = 56;
const MIN_FONT = 8, MAX_FONT = 32;

const FONTS = [
  { label: 'System (SF Mono)', css: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  { label: 'Menlo', css: 'Menlo, monospace' },
  { label: 'Monaco', css: 'Monaco, monospace' },
  { label: 'Courier New', css: '"Courier New", monospace' },
  { label: 'Andale Mono', css: '"Andale Mono", monospace' },
  { label: 'PT Mono', css: '"PT Mono", monospace' },
  { label: 'JetBrains Mono', css: '"JetBrains Mono", monospace' },
  { label: 'Fira Code', css: '"Fira Code", monospace' },
  { label: 'Cascadia Code', css: '"Cascadia Code", monospace' },
  { label: 'Source Code Pro', css: '"Source Code Pro", monospace' }
];
const DEFAULT_FONT = FONTS[0].css;
globalFontFamily = DEFAULT_FONT;

const DARK_PALETTE = [
  '#10131a', '#13303f', '#102a22', '#3a1f2b', '#2a2150', '#3a2e10', '#10222b', '#301630'
];
const LIGHT_PALETTE = [
  '#f5f7fb', '#e3eefc', '#e6f7f1', '#fcebf0', '#efeafc', '#fbf3e0', '#e8f5ec', '#f7e9f7'
];
const PRESET_COLORS = [
  '#10131a', '#1b1f2a', '#13303f', '#102a22', '#3a1f2b', '#2a2150', '#3a2e10', '#301630',
  '#0a3d62', '#6a1b1b', '#1b5e20', '#4a148c', '#bf360c', '#01579b', '#005b4f', '#7a5c00',
  '#f5f7fb', '#e3eefc', '#e6f7f1', '#fcebf0', '#fff3bf', '#d3f9d8', '#ffd8a8', '#e5dbff'
];

// Tile color themes — new terminals draw their background from the active theme.
const TILE_THEMES = {
  'Galaxy':            ['#0b0033', '#1a0a4a', '#2d1b69', '#4a148c', '#6a1b9a', '#0d1b3e', '#311b92', '#120024'],
  'Pacific Northwest': ['#1b3a2b', '#22372f', '#2f4f4f', '#34495e', '#3d5a4a', '#4b5d52', '#26343a', '#1f2d2a'],
  'Desert':            ['#7a4a2b', '#a86a3d', '#c98a5a', '#8a6d3b', '#b5894e', '#9c5b3b', '#6b4226', '#d2a679'],
  'Iceland':           ['#1a2a33', '#2c4a5a', '#3a6b7a', '#5a7a7a', '#0f1f26', '#4a6b6b', '#2e4a4a', '#dfe9ec'],
  'Ocean':             ['#012d4a', '#01497c', '#02639b', '#0a7fa8', '#013a63', '#155e75', '#0e4d64', '#003049'],
  'Sunlight':          ['#b5890a', '#d4a017', '#e8b923', '#f0c75e', '#caa42f', '#a87b00', '#dcae1d', '#9c7a10'],
  'Aurora Borealis':   ['#04150f', '#0a2e1f', '#103a2e', '#1b5e4a', '#2a7d6a', '#1a4a5a', '#2e2a5a', '#0d1b3e'],
  // Pride & heritage flags
  'LGBTQ Pride':       ['#e40303', '#ff8c00', '#ffed00', '#008026', '#004dff', '#750787', '#e40303', '#008026'],
  'Trans Pride':       ['#5bcefa', '#f5a9b8', '#ffffff', '#5bcefa', '#f5a9b8', '#ffffff', '#5bcefa', '#f5a9b8'],
  'Black Pride':       ['#000000', '#a4161a', '#0a6e3a', '#000000', '#a4161a', '#0a6e3a', '#000000', '#a4161a'],
  'Colombian':         ['#fcd116', '#003893', '#ce1126', '#fcd116', '#003893', '#ce1126', '#fcd116', '#003893'],
  'Nigerian':          ['#008751', '#ffffff', '#008751', '#ffffff', '#008751', '#ffffff', '#008751', '#ffffff'],
  'Mexican':           ['#006847', '#ffffff', '#ce1126', '#006847', '#ffffff', '#ce1126', '#006847', '#ce1126'],
  'Philippine':        ['#0038a8', '#ce1126', '#ffffff', '#fcd116', '#0038a8', '#ce1126', '#ffffff', '#fcd116'],
  'Canadian':          ['#d80621', '#ffffff', '#d80621', '#ffffff', '#d80621', '#ffffff', '#d80621', '#ffffff']
};
const THEME_ACCENTS = {
  'Galaxy': '#b86bd8', 'Pacific Northwest': '#3fb6a8', 'Desert': '#e0a060',
  'Iceland': '#7ec8e3', 'Ocean': '#00b4d8', 'Sunlight': '#FFD100', 'Aurora Borealis': '#5cf0c0',
  'LGBTQ Pride': '#cc44cc', 'Trans Pride': '#5bcefa', 'Black Pride': '#e31b23',
  'Colombian': '#fcd116', 'Nigerian': '#008751', 'Mexican': '#006847',
  'Philippine': '#0038a8', 'Canadian': '#d80621'
};
let tileTheme = '';   // '' = Auto (match dark/light mode)
function activePalette() {
  if (tileTheme && TILE_THEMES[tileTheme]) return TILE_THEMES[tileTheme];
  return themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
}

const MAX_TERMINALS = 30;
function totalTerminals() { return panes.length + stored.length; }

const gridEl = document.getElementById('grid');
const readoutEl = document.getElementById('layout-readout');
const displayReadoutEl = document.getElementById('display-readout');
const tpl = document.getElementById('pane-template');

// Hidden host that keeps collapsed terminals alive, + the tray bar.
const storedHost = document.createElement('div');
storedHost.id = 'stored-host';
document.body.appendChild(storedHost);
const trayEl = document.createElement('div');
trayEl.id = 'stored-tray';
document.body.appendChild(trayEl);

// ===========================================================================
// Lucide icon helpers
// ===========================================================================
function lic(name) { return `<i data-lucide="${name}"></i>`; }
function renderIcons() { try { window.lucide && window.lucide.createIcons(); } catch (_) {} }
function setBtnIcon(btn, name, label) {
  btn.innerHTML = lic(name) + (label != null ? `<span>${label}</span>` : '');
  if (label != null) { btn.title = label; btn.dataset.tooltip = label; }
  renderIcons();
}

// ===========================================================================
// Color / contrast — guarantees a legible foreground for ANY background
// ===========================================================================
function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function toHex6(hex) {
  const { r, g, b } = hexToRgb(hex);
  const h = (n) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function srgbToLin(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function luminance(hex) { const { r, g, b } = hexToRgb(hex); return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b); }
function contrast(l1, l2) { const a = Math.max(l1, l2), b = Math.min(l1, l2); return (a + 0.05) / (b + 0.05); }
// Pick black or white by whichever has the higher WCAG contrast ratio.
// This is always >= 4.58:1 (AA), so every possible background stays legible.
function readableFg(hex) {
  const L = luminance(hex);
  return contrast(L, 1) >= contrast(L, 0) ? '#ffffff' : '#000000';
}
function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  const h = (n) => Math.round(n).toString(16).padStart(2, '0');
  return `#${h(A.r + (B.r - A.r) * t)}${h(A.g + (B.g - A.g) * t)}${h(A.b + (B.b - A.b) * t)}`;
}

// THE CONTRAST RULE: every pane background must clear MIN_BG_CONTRAST against its
// best (black/white) text. If a chosen color can't, we darken or lighten it (keeping
// its hue) just enough until it does — so text is ALWAYS legible, on any color.
const MIN_BG_CONTRAST = 6.0;   // comfortably above WCAG AA (4.5); near AAA
function enforceContrast(bg) {
  bg = toHex6(bg);
  const fg = readableFg(bg);            // '#ffffff' or '#000000'
  const targetL = fg === '#ffffff' ? 1 : 0;
  if (contrast(luminance(bg), targetL) >= MIN_BG_CONTRAST) return bg;
  // White text → darken the background; black text → lighten it.
  const toward = fg;                    // blend bg toward the text's opposite extreme
  let out = bg;
  for (let t = 0.06; t <= 1.001; t += 0.06) {
    out = mixHex(bg, toward === '#ffffff' ? '#000000' : '#ffffff', t);
    if (contrast(luminance(out), targetL) >= MIN_BG_CONTRAST) break;
  }
  return out;
}
// Ensure an ANSI color stays legible on a given background (e.g. green text on a
// green flag tile): if its contrast is too low, blend it toward the foreground.
function legibleOn(hex, bgL, fg) {
  if (contrast(luminance(hex), bgL) >= 3) return hex;
  for (let t = 0.35; t < 1; t += 0.2) {
    const m = mixHex(hex, fg, t);
    if (contrast(luminance(m), bgL) >= 3) return m;
  }
  return fg;
}

// ===========================================================================
// Attention bell
// ===========================================================================
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function playChime() {
  if (soundMuted) return;
  const ctx = ensureAudio(); if (!ctx) return;
  const schedule = () => {
    const now = ctx.currentTime;
    [880, 1318.5].forEach((freq, i) => {
      const t = now + i * 0.16;
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.5);
    });
  };
  // A suspended context won't actually sound until resumed (the real "bell stopped" bug).
  if (ctx.state === 'suspended') ctx.resume().then(schedule).catch(() => {});
  else schedule();
}
const MAX_CHIMES = 6, CHIME_INTERVAL = 4000;
function triggerAttention(pane) {
  if (!alertsEnabled || !pane.bellOn) return;
  // Ignore bells that fire within 2 s of a keypress — these are shell feedback
  // (tab completion, mode-switch chimes) not an AI waiting for the user.
  // Use lastKeypress (user input only), not lastActivity (which also updates on PTY output,
  // which would suppress the bell fired by Claude at the end of its response).
  if (Date.now() - pane.lastKeypress < 2000) return;
  pane.el.classList.add('attn');
  if (!pane.attnTimer) {
    pane.chimeCount = 0;
    const fire = () => {
      if (pane.chimeCount < MAX_CHIMES) { playChime(); pane.chimeCount += 1; }
      else { clearInterval(pane.attnTimer); pane.attnTimer = null; }
    };
    fire();
    pane.attnTimer = setInterval(fire, CHIME_INTERVAL);
  }
}
function clearAttention(pane) {
  pane.el.classList.remove('attn');
  if (pane.attnTimer) { clearInterval(pane.attnTimer); pane.attnTimer = null; }
  pane.chimeCount = 0;
}

// ===========================================================================
// Layout — even tiling
// ===========================================================================
function rowCountsFor(n) {
  if (n <= 0) return [];
  if (n <= 4) return [n];
  let rows;
  if (n <= 6) rows = 2; else if (n <= 9) rows = 3; else rows = Math.ceil(Math.sqrt(n));
  const base = Math.floor(n / rows), extra = n % rows, counts = [];
  for (let r = 0; r < rows; r++) counts.push(base + (r < extra ? 1 : 0));
  return counts;
}
function relayout() {
  gridEl.querySelectorAll('.grid-row, .empty-hint').forEach((el) => el.remove());
  if (panes.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = stored.length
      ? 'All terminals stored — click one in the tray below to bring it back.'
      : 'No terminals. Press ⌘T or “New terminal”.';
    gridEl.appendChild(hint);
  } else {
    const counts = rowCountsFor(panes.length);
    let idx = 0;
    for (const count of counts) {
      const row = document.createElement('div');
      row.className = 'grid-row';
      for (let i = 0; i < count; i++) { row.appendChild(panes[idx].el); idx++; }
      gridEl.appendChild(row);
    }
  }
  readoutEl.textContent = panes.length === 1 ? '1 pane'
    : `${panes.length} panes${stored.length ? ` · ${stored.length} stored` : ''}`;
  renderIcons();
  requestAnimationFrame(() => panes.forEach(fitPane));
}
function fitPane(pane) {
  try {
    pane.fitAddon.fit();
    const { cols, rows } = pane.term;
    if (cols > 0 && rows > 0) window.api.resize(pane.id, cols, rows);
  } catch (_) {}
}

// ===========================================================================
// Per-pane appearance
// ===========================================================================
// ANSI palettes tuned for readability ON a dark vs light background, so program
// output (ls colors, git, npm, etc.) keeps proper contrast whatever the pane color is.
const ANSI_FOR_DARK = {
  black: '#5b6270', red: '#ff6b6b', green: '#7bd88f', yellow: '#ffd866',
  blue: '#82aaff', magenta: '#c792ea', cyan: '#5fd7d7', white: '#e6e9ef',
  brightBlack: '#8a93a6', brightRed: '#ff8787', brightGreen: '#a6e3a1', brightYellow: '#ffe9a3',
  brightBlue: '#9ec1ff', brightMagenta: '#e0b0ff', brightCyan: '#9af2f2', brightWhite: '#ffffff'
};
const ANSI_FOR_LIGHT = {
  black: '#1a1a1a', red: '#c0392b', green: '#1e8449', yellow: '#9a6b00',
  blue: '#1f5fbf', magenta: '#8e44ad', cyan: '#0e7490', white: '#3a3f4b',
  brightBlack: '#555a66', brightRed: '#e74c3c', brightGreen: '#1f8b4c', brightYellow: '#b7791f',
  brightBlue: '#2f6fe0', brightMagenta: '#a23fc0', brightCyan: '#138d90', brightWhite: '#11131a'
};

function applyColor(pane, color) {
  color = enforceContrast(toHex6(color));   // guarantee legible text on this background
  pane.color = color;
  const fg = readableFg(color);
  const bgL = luminance(color);
  const baseAnsi = bgL > 0.45 ? ANSI_FOR_LIGHT : ANSI_FOR_DARK;
  const ansi = {};
  for (const k in baseAnsi) ansi[k] = legibleOn(baseAnsi[k], bgL, fg);
  pane.headerEl.style.background = color;
  pane.headerEl.style.color = fg;
  pane.headerEl.style.borderBottom = `2px solid ${fg}33`;   // header divider line
  pane.nameInput.style.color = fg;
  pane.colorInput.value = color;
  pane.swatchBtn.style.setProperty('--swatch-fill', color);
  pane.swatchBtn.style.setProperty('--swatch-ring', fg);
  pane.term.options.theme = {
    background: color, foreground: fg, cursor: fg, cursorAccent: color,
    selectionBackground: fg === '#ffffff' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)',
    ...ansi
  };
  pane.bodyEl.style.background = color;
}
function applyTitleSizeToPane(pane, size) {
  pane.nameInput.style.fontSize = size + 'px';
  pane.headerEl.style.height = '';        // let the 2-row layout size itself
  pane.headerEl.style.flex = '0 0 auto';
}
// Global: apply to every pane (active + stored) and optionally sync other windows.
function applyGlobalTitleSize(size, fromRemote) {
  globalTitleSize = Math.max(MIN_TITLE, Math.min(MAX_TITLE, Math.round(size)));
  [...panes, ...stored].forEach((p) => applyTitleSizeToPane(p, globalTitleSize));
  requestAnimationFrame(() => panes.forEach(fitPane));
  if (!fromRemote) { saveGlobals(); window.api.broadcast({ type: 'titleSize', value: globalTitleSize }); }
}
// Text size / font / center title are GLOBAL — apply to every pane and sync windows.
function applyGlobalTextSize(size, fromRemote) {
  globalFontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round(size)));
  [...panes, ...stored].forEach((p) => { p.term.options.fontSize = globalFontSize; });
  requestAnimationFrame(() => panes.forEach(fitPane));
  if (!fromRemote) { saveGlobals(); window.api.broadcast({ type: 'textSize', value: globalFontSize }); }
}
function applyGlobalFont(css, fromRemote) {
  globalFontFamily = css;
  [...panes, ...stored].forEach((p) => { p.term.options.fontFamily = css; });
  requestAnimationFrame(() => panes.forEach(fitPane));
  if (!fromRemote) { saveGlobals(); window.api.broadcast({ type: 'font', value: css }); }
}
function applyGlobalTitleCenter(on, fromRemote) {
  globalTitleCenter = !!on;
  [...panes, ...stored].forEach((p) => p.nameInput.classList.toggle('centered', globalTitleCenter));
  if (!fromRemote) { saveGlobals(); window.api.broadcast({ type: 'titleCenter', value: globalTitleCenter }); }
}

// ===========================================================================
// Pane creation
// ===========================================================================
function createPane(opts = {}) {
  if (totalTerminals() >= MAX_TERMINALS) return null;
  paneCounter += 1;
  const id = `p${paneCounter}-${WIN_TAG}`;
  const name = opts.name || `Terminal ${paneCounter}`;
  const palette = activePalette();
  const color = toHex6(opts.color || palette[(paneCounter - 1) % palette.length]);

  const node = tpl.content.firstElementChild.cloneNode(true);
  const headerEl = node.querySelector('.pane-header');
  const bodyEl = node.querySelector('.pane-body');
  const termLayer = node.querySelector('.term-layer');
  const nameInput = node.querySelector('.pane-name');
  const colorInput = node.querySelector('.color-input');
  const swatchBtn = node.querySelector('.swatch-btn');
  const bellToggle = node.querySelector('.bell-toggle');
  const collapseBtn = node.querySelector('.collapse-btn');
  const closeBtn = node.querySelector('.close-btn');
  const viewToggle = node.querySelector('.view-toggle');
  const noteBtn = node.querySelector('.note-btn');
  const grip = node.querySelector('.grip');
  const webview = node.querySelector('.web-view');
  const webUrlInput = node.querySelector('.web-url');

  nameInput.value = name;

  const term = new Terminal({
    fontFamily: globalFontFamily,
    fontSize: globalFontSize,
    lineHeight: 1.1, fontWeight: 500, fontWeightBold: 700,
    cursorBlink: true, allowProposedApi: true, scrollback: 10000, macOptionIsMeta: true,
    // Option+drag forces a selection even when the running program (Claude Code, vim,
    // less, tmux) has mouse reporting on and would otherwise swallow the drag.
    macOptionClickForcesSelection: true,
    theme: { background: color, foreground: readableFg(color) }
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(termLayer);

  const pane = {
    id, name, color, term, fitAddon,
    el: node, headerEl, bodyEl, termLayer, nameInput, colorInput, swatchBtn,
    webview, webUrlInput, webMode: false, webUrl: opts.webUrl || '',
    bellOn: opts.bellOn !== false,
    note: opts.note || '', manualName: opts.manual !== undefined ? !!opts.manual : !!opts.name, noteBtn,
    collapsed: false, attnTimer: null, chimeCount: 0, lastActivity: Date.now(), lastKeypress: 0,
    cwd: opts.cwd || settings.projectsDir || '',   // updated by OSC 7 or cd detection
    detectedTool: null,
    aiName: opts.aiName || '',
  };
  // OSC 7: shell emits \x1b]7;file:///path\x07 after each prompt — track current directory
  if (term.parser && term.parser.registerOscHandler) {
    term.parser.registerOscHandler(7, (data) => {
      try {
        const next = decodeURIComponent(new URL(data).pathname);
        if (next && next !== pane.cwd) {
          pane.cwd = next;
          window.api.transcriptMeta(id, { cwd: next });   // so recovery reopens here
        }
      } catch (_) {}
      return false;
    });
  }
  panes.push(pane);

  applyColor(pane, color);
  applyTitleSizeToPane(pane, globalTitleSize);
  nameInput.classList.toggle('centered', globalTitleCenter);
  if (!pane.bellOn) { bellToggle.querySelector('i')?.setAttribute('data-lucide', 'bell-off'); bellToggle.classList.add('off'); renderIcons(); }

  // PTY <-> terminal
  term.onData((data) => { window.api.input(id, data); pane.lastActivity = Date.now(); pane.lastKeypress = Date.now(); clearAttention(pane); });
  term.onResize(({ cols, rows }) => window.api.resize(id, cols, rows));
  term.onBell(() => triggerAttention(pane));

  // Follow the terminal title (OSC) — update the AI name field, not the user's name.
  term.onTitleChange((title) => {
    if (!settings.nameFromTitle) return;
    const t = (title || '').trim();
    if (t.length < 2 || t.length > 60) return;
    if (/^~?\//.test(t) && !/\s/.test(t)) return;          // ignore bare paths
    if (/^\S+@\S+/.test(t)) return;                          // ignore user@host
    pane.aiName = t; pane.aiNameEl.textContent = t; pane.aiSepEl.style.display = ''; scheduleSave();
  });

  // Click to position the shell cursor — HORIZONTAL only, and only on the line the
  // cursor is already on. (Sending up/down arrows would trigger shell history, which
  // is what was popping up your previous commands.)
  termLayer.addEventListener('mouseup', (ev) => {
    if (!settings.clickToMove) return;
    if (term.hasSelection && term.hasSelection()) return;     // a drag-select, not a click
    const screen = termLayer.querySelector('.xterm-screen');
    if (!screen) return;
    const r = screen.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cellW = r.width / term.cols, cellH = r.height / term.rows;
    const tx = Math.max(0, Math.min(term.cols - 1, Math.round((ev.clientX - r.left) / cellW)));
    const ty = Math.floor((ev.clientY - r.top) / cellH);
    const cx = term.buffer.active.cursorX, cy = term.buffer.active.cursorY;
    if (ty !== cy) return;                                     // different row → don't move (never send up/down)
    const dCol = tx - cx;
    if (!dCol) return;
    window.api.input(id, (dCol > 0 ? '\x1b[C' : '\x1b[D').repeat(Math.abs(dCol)));
  });

  // Drag & drop files from Finder → insert their shell-escaped paths at the cursor.
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  termLayer.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; node.classList.add('file-drop'); } });
  termLayer.addEventListener('dragleave', (e) => { if (!termLayer.contains(e.relatedTarget)) node.classList.remove('file-drop'); });
  termLayer.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    node.classList.remove('file-drop');
    const paths = Array.from(e.dataTransfer.files).map((f) => window.api.getPathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const escaped = paths.map((p) => "'" + p.replace(/'/g, "'\\''") + "'").join(' ') + ' ';
    window.api.input(id, escaped);
    setFocused(id); term.focus(); pane.lastActivity = Date.now();
  });

  // Companion browser
  const normalizeUrl = (v) => {
    v = (v || '').trim(); if (!v) return '';
    if (/^(https?|file):\/\//i.test(v)) return v;
    if (/^[~/]/.test(v)) return 'file://' + v.replace(/^~/, '');
    if (/^localhost[:/]/i.test(v) || /^\d+\.\d+\.\d+\.\d+/.test(v) || /^[\w-]+(\.[\w-]+)+/.test(v)) return 'http://' + v;
    return 'http://' + v;
  };
  const loadWeb = (v) => { const url = normalizeUrl(v); if (!url) return; pane.webUrl = url; webUrlInput.value = url; try { webview.src = url; } catch (_) {} scheduleSave(); };
  const setWebMode = (on) => {
    pane.webMode = on;
    node.classList.toggle('web-mode', on);
    viewToggle.innerHTML = lic(on ? 'terminal' : 'globe'); renderIcons();
    if (on) { if (pane.webUrl && webview.getAttribute('src') !== pane.webUrl) webview.src = pane.webUrl; webUrlInput.focus(); }
    else { setTimeout(() => { fitPane(pane); term.focus(); }, 0); }
  };
  viewToggle.addEventListener('click', () => setWebMode(!pane.webMode));

  // Links in terminal output: open in the companion browser (preference) or externally.
  if (window.WebLinksAddon) {
    term.loadAddon(new WebLinksAddon.WebLinksAddon((event, uri) => {
      if (settings.openInApp) { loadWeb(uri); setWebMode(true); }
      else window.open(uri, '_blank');
    }));
  }

  webUrlInput.value = pane.webUrl;
  webUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadWeb(webUrlInput.value); });
  node.querySelector('.web-go').addEventListener('click', () => loadWeb(webUrlInput.value));
  node.querySelector('.web-reload').addEventListener('click', () => { try { webview.reload(); } catch (_) {} });
  node.querySelector('.web-back').addEventListener('click', () => { try { if (webview.canGoBack()) webview.goBack(); } catch (_) {} });
  node.querySelector('.web-open').addEventListener('click', async () => {
    const r = await window.api.pickFile();
    if (r && r.ok) loadWeb('file://' + r.path);
  });
  webview.addEventListener('did-navigate', (e) => { if (e.url) { pane.webUrl = e.url; webUrlInput.value = e.url; } });

  // Keyboard: Ctrl+Tab cycles; plain Tab cycles when the setting is on.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;

    // Paste: Cmd+V is deliberately NOT handled here. The Edit menu role owns the
    // accelerator and fires a real paste into xterm's textarea; xterm then emits it
    // via onData with proper bracketed-paste framing. Intercepting it here sent the
    // text a second time (doubled pastes) and skipped the \e[200~ wrapper, which
    // broke multi-line pastes into Claude Code.

    // Copy: Cmd+C is owned by the Edit menu item, which calls copyFocusedSelection()
    // in the renderer. Handling it here as well raced the menu and could leave the
    // clipboard holding only the current line.

    if (e.key !== 'Tab') return true;
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    // Ctrl+Tab / Ctrl+Shift+Tab always cycle panes.
    if (e.ctrlKey) { cyclePane(e.shiftKey ? -1 : 1); return false; }
    // tabSwitch: only plain Tab (no Shift) cycles forward. Shift+Tab always passes through
    // so Claude Code's plan/auto/accept-edits mode switcher works.
    if (settings.tabSwitch && plain && !e.shiftKey) { cyclePane(1); return false; }
    return true;
  });

  const acknowledge = (e) => {
    setFocused(id); clearAttention(pane); pane.lastActivity = Date.now();
    ensureAudio();
    // Focus the terminal unless the click landed on an interactive element (input/textarea)
    // that needs to retain its own focus (e.g. the rename field, note popover).
    if (!e || !e.target || !e.target.closest('input, textarea')) term.focus();
  };
  node.addEventListener('mousedown', acknowledge);
  if (term.textarea) term.textarea.addEventListener('focus', acknowledge);

  // Rename (a manual edit stops AI auto-naming for this pane)
  nameInput.addEventListener('change', () => {
    pane.name = nameInput.value; pane.manualName = true;
    window.api.transcriptMeta(id, { name: pane.name });
    scheduleSave();
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { nameInput.blur(); term.focus(); } });

  // AI-generated name displayed alongside the user's editable name
  const aiSepEl = document.createElement('span'); aiSepEl.className = 'ai-name-sep'; aiSepEl.textContent = '·';
  nameInput.insertAdjacentElement('afterend', aiSepEl);
  pane.aiSepEl = aiSepEl;
  const aiNameEl = document.createElement('span'); aiNameEl.className = 'ai-name';
  aiSepEl.insertAdjacentElement('afterend', aiNameEl);
  pane.aiNameEl = aiNameEl;
  if (pane.aiName) aiNameEl.textContent = pane.aiName;
  aiSepEl.style.display = pane.aiName ? '' : 'none';

  // AI-model badge (detected from the pane's recent output)
  const modelBadge = document.createElement('span'); modelBadge.className = 'model-badge';
  aiNameEl.insertAdjacentElement('afterend', modelBadge);
  pane.modelBadge = modelBadge;

  // Per-window note ("what I'm working on") — saved with the session
  noteBtn.classList.toggle('has-note', !!pane.note);
  noteBtn.addEventListener('click', () => openNotePopover(pane, noteBtn));

  // Color: chip opens preset popover; hidden input is the custom picker
  swatchBtn.addEventListener('click', () => openColorPopover(pane, swatchBtn));
  colorInput.addEventListener('input', () => { applyColor(pane, colorInput.value); scheduleSave(); });

  // Bell toggle
  bellToggle.addEventListener('click', () => {
    pane.bellOn = !pane.bellOn;
    bellToggle.classList.toggle('off', !pane.bellOn);
    bellToggle.innerHTML = lic(pane.bellOn ? 'bell' : 'bell-off'); renderIcons();
    if (!pane.bellOn) clearAttention(pane);
    scheduleSave();
  });

  collapseBtn.addEventListener('click', () => collapsePane(pane));
  closeBtn.addEventListener('click', () => closePane(id));

  // Drag to reorder (via grip)
  grip.addEventListener('dragstart', (e) => {
    dragSrcId = id; node.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch (_) {}
  });
  grip.addEventListener('dragend', () => {
    dragSrcId = null; node.classList.remove('dragging');
    document.querySelectorAll('.pane.drop-target').forEach((el) => el.classList.remove('drop-target'));
  });
  node.addEventListener('dragover', (e) => { if (dragSrcId && dragSrcId !== id) { e.preventDefault(); node.classList.add('drop-target'); } });
  node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
  node.addEventListener('drop', (e) => {
    e.preventDefault(); node.classList.remove('drop-target');
    if (!dragSrcId || dragSrcId === id) return;
    const from = panes.findIndex((p) => p.id === dragSrcId);
    const to = panes.findIndex((p) => p.id === id);
    if (from < 0 || to < 0) return;
    const [moved] = panes.splice(from, 1);
    panes.splice(to, 0, moved);
    relayout(); scheduleSave();
  });

  // Refit on size changes
  const ro = new ResizeObserver(() => fitPane(pane));
  ro.observe(bodyEl);
  pane.resizeObserver = ro;

  renderIcons();

  // Spawn the shell
  fitAddon.fit();
  window.api.spawn({
    id, cols: term.cols || 80, rows: term.rows || 24,
    // opts.cwd wins so a recovered session reopens in the directory it was in.
    cwd: opts.cwd || settings.projectsDir || undefined,
    name, color
  }).then((res) => {
    if (!res || !res.ok) { term.writeln('\x1b[31mFailed to start shell: ' + (res && res.error ? res.error : 'unknown') + '\x1b[0m'); return; }
    pane.transcript = res.transcript || '';
    if (res.cwd) pane.cwd = res.cwd;
  });

  return pane;
}

let dragSrcId = null;

function addPane(opts) {
  ensureAudio();
  const pane = createPane(opts || {});
  if (!pane) { flashCap(); return null; }
  relayout();
  setFocused(pane.id);
  setTimeout(() => pane.term.focus(), 30);
  scheduleSave();
  return pane;
}

// Open N terminals at once (respects the 30-terminal cap).
function addMany(n) {
  ensureAudio();
  const room = MAX_TERMINALS - totalTerminals();
  const count = Math.max(0, Math.min(n, room));
  if (count <= 0) { flashCap(); return; }
  let last = null;
  for (let i = 0; i < count; i++) { const p = createPane(); if (p) last = p; }
  relayout();
  if (last) { setFocused(last.id); setTimeout(() => last.term.focus(), 30); }
  scheduleSave();
  if (n > room) flashCap();
}

function flashCap() {
  readoutEl.textContent = `Max ${MAX_TERMINALS} terminals`;
  readoutEl.style.color = '#FFD100';
  setTimeout(() => { readoutEl.style.color = ''; relayout(); }, 1400);
}

function closePane(id, skipRecord) {
  const i = panes.findIndex((p) => p.id === id);
  if (i === -1) return;
  if (!skipRecord && panes.length === 1 && stored.length === 0) {
    if (!confirm('Close the last terminal? This window will close.')) return;
  }
  const pane = panes[i];
  if (!skipRecord) recordClosed(pane);
  clearAttention(pane);
  if (pane.resizeObserver) pane.resizeObserver.disconnect();
  window.api.kill(id);
  pane.term.dispose();
  panes.splice(i, 1);
  // Closing the last pane (nothing active or stored) closes the window → quits the
  // app when it's the last window. Clear this window's saved layout so reopening
  // starts fresh (recently-closed via Cmd+Shift+T still recovers it).
  if (panes.length === 0 && stored.length === 0) { try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY + ':bak'); } catch (_) {} window.close(); return; }
  if (focusedId === id && panes.length) setFocused(panes[Math.max(0, i - 1)].id);
  relayout();
  setTimeout(() => { const f = panes.find((p) => p.id === focusedId); if (f) f.term.focus(); }, 0);
  scheduleSave();
}

function setFocused(id) {
  focusedId = id;
  for (const p of panes) p.el.classList.toggle('focused', p.id === id);
}
function cyclePane(dir) {
  if (panes.length < 2) return;
  let idx = panes.findIndex((p) => p.id === focusedId);
  if (idx < 0) idx = 0;
  const next = panes[(idx + dir + panes.length) % panes.length];
  setFocused(next.id); next.term.focus();
}

// ===========================================================================
// Collapse / store + tray
// ===========================================================================
function collapsePane(pane, silent) {
  if (pane.collapsed) return;
  const i = panes.findIndex((p) => p.id === pane.id);
  if (i === -1) return;
  panes.splice(i, 1);
  stored.push(pane);
  pane.collapsed = true;
  clearAttention(pane);
  storedHost.appendChild(pane.el);     // keep alive, out of layout
  if (focusedId === pane.id && panes.length) {
    setFocused(panes[Math.max(0, i - 1)].id);
    setTimeout(() => { const f = panes.find((p) => p.id === focusedId); if (f) f.term.focus(); }, 30);
  }
  renderTray();
  relayout();
  if (!silent) scheduleSave();
}
function restorePane(pane) {
  const i = stored.findIndex((p) => p.id === pane.id);
  if (i === -1) return;
  stored.splice(i, 1);
  pane.collapsed = false;
  panes.push(pane);
  renderTray();
  relayout();
  setFocused(pane.id);
  setTimeout(() => { fitPane(pane); pane.term.focus(); }, 30);
  scheduleSave();
}
function renderTray() {
  document.documentElement.style.setProperty('--tray-h', stored.length ? '38px' : '0px');
  trayEl.classList.toggle('show', stored.length > 0);
  trayEl.innerHTML = '';
  if (!stored.length) { requestAnimationFrame(() => panes.forEach(fitPane)); return; }
  const label = document.createElement('span');
  label.className = 'tray-label'; label.textContent = 'Stored';
  trayEl.appendChild(label);
  for (const pane of stored) {
    const fg = readableFg(pane.color);
    const chip = document.createElement('div');
    chip.className = 'tray-chip';
    chip.style.setProperty('--chip-fill', pane.color);
    chip.style.setProperty('--chip-fg', fg);
    chip.style.setProperty('--chip-ring', fg);
    chip.title = 'Click to restore';
    const text = document.createElement('span');
    text.textContent = pane.nameInput.value || pane.name;
    chip.appendChild(text);
    const x = document.createElement('span');
    x.className = 'chip-x'; x.innerHTML = lic('x'); x.title = 'Close stored terminal';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeStored(pane); });
    chip.appendChild(x);
    chip.addEventListener('click', () => restorePane(pane));
    trayEl.appendChild(chip);
  }
  renderIcons();
  requestAnimationFrame(() => panes.forEach(fitPane));
}
function closeStored(pane, skipRecord) {
  const i = stored.findIndex((p) => p.id === pane.id);
  if (i === -1) return;
  if (!skipRecord) recordClosed(pane);
  stored.splice(i, 1);
  if (pane.resizeObserver) pane.resizeObserver.disconnect();
  window.api.kill(pane.id);
  pane.term.dispose();
  pane.el.remove();
  renderTray();
  if (panes.length === 0 && stored.length === 0) { try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY + ':bak'); } catch (_) {} window.close(); return; }
  scheduleSave();
}

// Auto-collapse idle panes
setInterval(() => {
  if (!settings.autoCollapse) return;
  const cutoff = Date.now() - settings.autoCollapseMin * 60000;
  for (const pane of [...panes]) {
    if (panes.length <= 1) break;                       // keep at least one visible
    if (pane.id === focusedId) continue;
    if (pane.lastActivity < cutoff) collapsePane(pane);
  }
}, 30000);

// ===========================================================================
// Popovers
// ===========================================================================
let openPop = null;
function closePopover() {
  if (openPop) { openPop.remove(); openPop = null; document.removeEventListener('mousedown', onOutside, true); }
}
function onOutside(e) {
  if (openPop && !openPop.contains(e.target) && (!openPop.__anchor || !openPop.__anchor.contains(e.target))) closePopover();
}
function openPopover(anchor, contentEl) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'popover'; pop.__anchor = anchor;
  pop.appendChild(contentEl);
  document.body.appendChild(pop);
  renderIcons();
  pop.style.visibility = 'hidden';
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  pop.style.visibility = 'visible';
  openPop = pop;
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
  return pop;
}

function stepperRow(labelText, getVal, onMinus, onPlus) {
  const row = document.createElement('div'); row.className = 'pop-row';
  const span = document.createElement('span'); span.textContent = labelText;
  const step = document.createElement('span'); step.className = 'stepper';
  const minus = document.createElement('button'); minus.textContent = '−';
  const val = document.createElement('b'); val.textContent = getVal();
  const plus = document.createElement('button'); plus.textContent = '＋';
  minus.addEventListener('click', () => { onMinus(); val.textContent = getVal(); });
  plus.addEventListener('click', () => { onPlus(); val.textContent = getVal(); });
  step.append(minus, val, plus);
  row.append(span, step);
  return row;
}
function checkRow(label, getChecked, onChange) {
  const row = document.createElement('label'); row.className = 'pop-row checkbox';
  const sp = document.createElement('span'); sp.textContent = label;
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = getChecked();
  cb.addEventListener('change', () => onChange(cb.checked));
  row.append(sp, cb); return row;
}
function textRow(label, get, set, placeholder, type, withPick) {
  const row = document.createElement('div'); row.className = 'pop-row';
  const sp = document.createElement('span'); sp.textContent = label;
  const inp = document.createElement('input');
  inp.type = type || 'text'; inp.value = get() || ''; inp.spellcheck = false; if (placeholder) inp.placeholder = placeholder;
  inp.style.cssText = 'flex:1 1 auto;max-width:150px;background:var(--btn-bg);color:inherit;border:1px solid var(--pop-line);border-radius:6px;padding:4px 6px;font-size:12px';
  inp.addEventListener('change', () => set(inp.value.trim()));
  row.append(sp, inp);
  if (withPick) {
    const pick = document.createElement('button'); pick.className = 'web-btn'; pick.title = 'Choose folder…'; pick.innerHTML = lic('folder-open');
    pick.addEventListener('click', async () => { const r = await window.api.pickFolder(); if (r && r.ok) { inp.value = r.path; set(r.path); } });
    row.append(pick);
  }
  return row;
}
function settingsChanged() { applySettings(); saveGlobals(); window.api.broadcast({ type: 'settings', value: { ...settings } }); }

function openNotePopover(pane, anchor) {
  const c = document.createElement('div');
  const title = document.createElement('div'); title.className = 'pop-title'; title.textContent = 'What are you working on?';
  c.appendChild(title);
  const ta = document.createElement('textarea');
  ta.value = pane.note || '';
  ta.placeholder = 'e.g. Fixing the checkout bug on the storefront repo…';
  ta.rows = 4;
  ta.style.cssText = 'width:240px;max-width:70vw;resize:vertical;background:var(--btn-bg);color:inherit;border:1px solid var(--pop-line);border-radius:8px;padding:8px;font:inherit;font-size:13px';
  ta.addEventListener('input', () => { pane.note = ta.value; pane.noteBtn.classList.toggle('has-note', !!pane.note.trim()); scheduleSave(); });
  c.appendChild(ta);
  const note = document.createElement('div'); note.className = 'layout-empty';
  note.textContent = 'Saved with this window and restored when DiscoVibe reopens.';
  c.appendChild(note);
  openPopover(anchor, c);
  setTimeout(() => ta.focus(), 30);
}

// AI naming: derive a short label from a pane's recent activity (opt-in, needs the AI key).
async function aiSuggestName(pane) {
  const buf = pane.term.buffer.active; const lines = [];
  for (let i = Math.max(0, buf.length - 40); i < buf.length; i++) { const ln = buf.getLine(i); if (ln) { const s = ln.translateToString(true); if (s.trim()) lines.push(s); } }
  const text = lines.slice(-30).join('\n').slice(-2000);
  if (text.trim().length < 20) return '';
  const res = await fetch(voiceAI.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + voiceAI.apiKey, 'HTTP-Referer': 'https://launchindustries.biz', 'X-Title': 'DiscoVibe' },
    body: JSON.stringify({
      model: voiceAI.model, temperature: 0.3, max_tokens: 12,
      messages: [
        { role: 'system', content: 'You name a terminal tab from its recent output. Reply with a 2-4 word Title Case label describing the task/project — no quotes, no punctuation, no explanation.' },
        { role: 'user', content: text }
      ]
    })
  });
  if (!res.ok) return '';
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim().replace(/^["'`]|["'`.]+$/g, '').slice(0, 40);
}
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function showRenameOffer(pane, suggestion) {
  const el = pane.offerEl;
  el.innerHTML = `<span>→ ${suggestion.replace(/</g, '&lt;')}</span>`;
  const ok = document.createElement('button'); ok.innerHTML = lic('check'); ok.title = 'Rename';
  const no = document.createElement('button'); no.innerHTML = lic('x'); no.title = 'Keep current name';
  ok.addEventListener('click', () => { pane.name = suggestion; pane.nameInput.value = suggestion; el.classList.remove('show'); scheduleSave(); });
  no.addEventListener('click', () => { pane._dismissed = suggestion; el.classList.remove('show'); });
  el.append(ok, no); el.classList.add('show'); renderIcons();
}
// Detect which AI model a pane is using by scanning its recent output.
const MODEL_PATTERNS = [
  [/\bclaude[- ]?opus\b|\bopus\b/i, 'Opus'],
  [/\bclaude[- ]?sonnet\b|\bsonnet\b/i, 'Sonnet'],
  [/\bclaude[- ]?haiku\b|\bhaiku\b/i, 'Haiku'],
  [/\bgpt-?5\b/i, 'GPT-5'], [/\bgpt-?4o\b/i, 'GPT-4o'], [/\bo3\b/i, 'o3'],
  [/\bcodex\b/i, 'Codex'], [/\bgemini\b/i, 'Gemini'], [/\bqwen\b/i, 'Qwen'],
  [/\bllama\b/i, 'Llama'], [/\bmistral\b/i, 'Mistral'], [/\bgrok\b/i, 'Grok']
];
function detectModel(pane) {
  const buf = pane.term.buffer.active;
  const start = Math.max(0, buf.length - 60);
  for (let i = buf.length - 1; i >= start; i--) {       // newest line first
    const ln = buf.getLine(i); if (!ln) continue;
    const s = ln.translateToString(true);
    if (!s.trim()) continue;
    for (const [re, label] of MODEL_PATTERNS) if (re.test(s)) return label;
  }
  return '';
}
function updateModelBadge(pane) {
  const label = settings.showModel ? detectModel(pane) : '';
  if (pane._model === label) return;
  pane._model = label;
  pane.modelBadge.textContent = label;
  pane.modelBadge.classList.toggle('show', !!label);
}
setInterval(() => { for (const p of panes) updateModelBadge(p); }, 4000);

// Scan non-focused panes for prompt-waiting patterns; alert after 30 s of idle time.
const PROMPT_IDLE_MS = 30000;
const PROMPT_PATTERNS = [
  /\[y\/n\]/i, /\(y\/N\)/i, /\[yes\/no\]/i, /\(Y\/n\)/i,
  /press enter/i, /press any key/i,
  // Claude Code permission / confirmation prompts. Deliberately NOT matching its idle
  // input box — that's on screen whenever Claude is simply waiting, and would chime
  // constantly. Only an explicit question counts.
  /\bDo you want to\b/i,
  /\bDo you trust the files\b/i,
  /No, and tell Claude/i,
  /❯?\s*1\.\s*Yes\b/,
];
function scanForPrompt(pane) {
  const buf = pane.term.buffer.active;
  // 20 lines, not 8: a Claude Code prompt puts its question above the option list,
  // box borders and hint line, so 8 rows can miss the question entirely.
  const start = Math.max(0, buf.length - 20);
  for (let i = buf.length - 1; i >= start; i--) {
    const ln = buf.getLine(i); if (!ln) continue;
    const s = ln.translateToString(true);
    if (!s.trim()) continue;
    for (const re of PROMPT_PATTERNS) if (re.test(s)) return true;
  }
  return false;
}
setInterval(() => {
  if (!alertsEnabled) return;
  const now = Date.now();
  for (const p of panes) {
    if (p.id === focusedId && !settings.alertFocused) continue;
    if (p.attnTimer) continue;
    if (now - p.lastActivity < PROMPT_IDLE_MS) continue;
    if (p.bellOn && scanForPrompt(p)) triggerAttention(p);
  }
}, 5000);

// ===========================================================================
// AI tool detection + session resume
// ===========================================================================
const TOOL_PATTERNS = [
  [/Claude Code|✻\s|> claude\b/i,  'claude'],
  [/Codex Agent|codex\.openai/i,   'codex'],
  [/Aider\s+v\d/i,                 'aider'],
  [/Gemini CLI|Google Gemini/i,    'gemini'],
  [/Kiro\s*[–-]/i,                 'kiro'],
];
const TOOL_DISPLAY = { claude: 'Claude Code', codex: 'Codex CLI', aider: 'Aider', gemini: 'Gemini CLI', kiro: 'Kiro CLI' };

function detectTool(pane) {
  const buf = pane.term.buffer.active;
  const start = Math.max(0, buf.length - 60);
  for (let i = buf.length - 1; i >= start; i--) {
    const ln = buf.getLine(i); if (!ln) continue;
    const s = ln.translateToString(true); if (!s.trim()) continue;
    for (const [re, tool] of TOOL_PATTERNS) if (re.test(s)) return tool;
  }
  return null;
}

function buildResumeCmd(tool, cwd) {
  const cd = cwd ? `cd ${JSON.stringify(cwd)} && ` : '';
  const cmds = { claude: 'claude -c', codex: 'codex', aider: 'aider', gemini: 'gemini', kiro: 'kiro-cli' };
  return cd + (cmds[tool] || tool);
}

const RESUME_KEY = 'discovibe.resume.v1';
function loadResume() { try { return JSON.parse(localStorage.getItem(RESUME_KEY)) || {}; } catch (_) { return {}; } }
function saveResume(d) { try { localStorage.setItem(RESUME_KEY, JSON.stringify(d)); } catch (_) {} }
function clearResumeEntry(cwd) { const d = loadResume(); delete d[cwd]; saveResume(d); }

function maybeShowResumeBanner(pane) {
  if (!pane.cwd) return;
  const resume = loadResume();
  const entry = resume[pane.cwd];
  if (!entry) return;
  if (Date.now() - entry.timestamp > 7 * 24 * 60 * 60 * 1000) { clearResumeEntry(pane.cwd); return; }
  const banner = pane.el.querySelector('.resume-banner');
  if (!banner) return;
  const cwdShort = entry.cwd.replace(/^\/Users\/[^/]+/, '~');
  banner.querySelector('.resume-text').textContent =
    `Resume ${TOOL_DISPLAY[entry.tool] || entry.tool} session · ${cwdShort}`;
  banner.hidden = false;
  renderIcons();
  banner.querySelector('.resume-run-btn').onclick = () => {
    window.api.input(pane.id, entry.cmd + '\r'); pane.lastActivity = Date.now();
    banner.hidden = true; clearResumeEntry(pane.cwd); pane.term.focus();
  };
  banner.querySelector('.resume-dismiss-btn').onclick = () => {
    banner.hidden = true; clearResumeEntry(pane.cwd);
  };
}

// Poll for tool detection alongside model badge updates
setInterval(() => {
  for (const p of panes) {
    const tool = detectTool(p);
    if (tool && !p.detectedTool) p.detectedTool = tool;
  }
}, 4000);

let autoNameBusy = false;
async function autoNamePass(force) {
  if (!settings.autoName || !voiceAI.apiKey || autoNameBusy) return;
  autoNameBusy = true;
  for (const p of [...panes]) {
    const sig = p.term.buffer.active.length;
    if (!force && p._lastNameSig === sig) continue;   // no new output since last check
    p._lastNameSig = sig;
    try {
      const suggestion = await aiSuggestName(p);
      if (!suggestion) continue;
      if (norm(suggestion) !== norm(p.aiName || '')) {
        p.aiName = suggestion;
        p.aiNameEl.textContent = suggestion;
        p.aiSepEl.style.display = '';
        scheduleSave();
      }
    } catch (_) {}
  }
  autoNameBusy = false;
}
setInterval(() => autoNamePass(false), 30000);

// Auto-configure the AI endpoint + model from the key's prefix so pasting any
// supported key "just works" without also editing the endpoint.
function autoConfigAI(key) {
  key = (key || '').trim();
  if (key.startsWith('AIza')) { voiceAI.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'; voiceAI.model = 'gemini-2.0-flash'; }
  else if (key.startsWith('sk-or-')) { voiceAI.baseUrl = 'https://openrouter.ai/api/v1/chat/completions'; voiceAI.model = 'qwen/qwen-2.5-coder-32b-instruct:free'; }
  else if (key.startsWith('gsk_')) { voiceAI.baseUrl = 'https://api.groq.com/openai/v1/chat/completions'; voiceAI.model = 'llama-3.3-70b-versatile'; }
  else if (key.startsWith('sk-')) { voiceAI.baseUrl = 'https://api.openai.com/v1/chat/completions'; voiceAI.model = 'gpt-4o-mini'; }
}

function openColorPopover(pane, anchor) {
  const c = document.createElement('div');
  const title = document.createElement('div'); title.className = 'pop-title'; title.textContent = 'Background color';
  c.appendChild(title);
  const grid = document.createElement('div'); grid.className = 'preset-grid';
  PRESET_COLORS.forEach((col) => {
    const sw = document.createElement('div'); sw.className = 'preset';
    sw.style.background = col;
    if (toHex6(col) === toHex6(pane.color)) sw.classList.add('current');
    sw.title = col;
    sw.addEventListener('click', () => { applyColor(pane, col); scheduleSave(); closePopover(); });
    grid.appendChild(sw);
  });
  c.appendChild(grid);
  const actions = document.createElement('div'); actions.className = 'pop-actions';
  const custom = document.createElement('button');
  custom.innerHTML = lic('pipette') + '<span>Custom…</span>';
  custom.addEventListener('click', () => { pane.colorInput.click(); });
  actions.appendChild(custom);
  c.appendChild(actions);
  openPopover(anchor, c);
}

// Quick settings popover — only the things people tweak often.
function openGlobalSettings(anchor) {
  const c = document.createElement('div');
  const title = document.createElement('div'); title.className = 'pop-title'; title.textContent = 'Quick settings';
  c.appendChild(title);

  c.appendChild(stepperRow('Title size', () => globalTitleSize + 'px',
    () => applyGlobalTitleSize(globalTitleSize - 2), () => applyGlobalTitleSize(globalTitleSize + 2)));
  c.appendChild(stepperRow('Text size', () => globalFontSize + 'px',
    () => applyGlobalTextSize(globalFontSize - 1), () => applyGlobalTextSize(globalFontSize + 1)));
  c.appendChild(checkRow('Center titles', () => globalTitleCenter, (v) => applyGlobalTitleCenter(v)));
  c.appendChild(checkRow('Dim inactive', () => settings.dimInactive, (v) => { settings.dimInactive = v; settingsChanged(); }));
  c.appendChild(stepperRow('Dim amount', () => Math.round((1 - settings.dimLevel) * 100) + '%',
    () => { settings.dimLevel = Math.min(0.9, +(settings.dimLevel + 0.1).toFixed(2)); settingsChanged(); },
    () => { settings.dimLevel = Math.max(0.1, +(settings.dimLevel - 0.1).toFixed(2)); settingsChanged(); }));
  c.appendChild(checkRow('Disco mode ✨', () => settings.disco, (v) => { settings.disco = v; settingsChanged(); }));

  const more = document.createElement('button'); more.className = 'pop-custom'; more.style.marginTop = '10px';
  more.innerHTML = lic('sliders-horizontal') + '<span>All preferences  (⌘,)</span>';
  more.addEventListener('click', () => { closePopover(); openPreferences(); });
  c.appendChild(more);
  openPopover(anchor, c);
}

// Full preferences — the set-and-forget configuration, in a modal.
function openPreferences() {
  if (document.getElementById('prefs')) return;
  const ov = document.createElement('div'); ov.id = 'prefs';
  const card = document.createElement('div'); card.className = 'ob-card'; card.style.maxWidth = '480px';
  ov.appendChild(card);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
  const head = document.createElement('div'); head.className = 'ob-head'; head.innerHTML = lic('sliders-horizontal') + ' Preferences';
  card.appendChild(head);
  const sec = (t) => { const d = document.createElement('div'); d.className = 'pop-title'; d.style.marginTop = '14px'; d.textContent = t; card.appendChild(d); };

  sec('Behavior');
  card.appendChild(checkRow('Alert the terminal I’m working in', () => settings.alertFocused, (v) => { settings.alertFocused = v; settingsChanged(); }));
  card.appendChild(checkRow('Auto-collapse idle terminals', () => settings.autoCollapse, (v) => { settings.autoCollapse = v; settingsChanged(); }));
  card.appendChild(stepperRow('Idle minutes', () => settings.autoCollapseMin + 'm',
    () => { settings.autoCollapseMin = Math.max(1, settings.autoCollapseMin - 5); settingsChanged(); },
    () => { settings.autoCollapseMin = Math.min(600, settings.autoCollapseMin + 5); settingsChanged(); }));
  card.appendChild(checkRow('Click to place cursor', () => settings.clickToMove, (v) => { settings.clickToMove = v; settingsChanged(); }));
  card.appendChild(checkRow('Switch panes with Tab (off = shell completion)', () => settings.tabSwitch, (v) => { settings.tabSwitch = v; settingsChanged(); }));
  card.appendChild(checkRow('Auto-name terminals from activity (AI)', () => settings.autoName, (v) => { settings.autoName = v; settingsChanged(); }));
  card.appendChild(checkRow('Set window name from terminal title', () => settings.nameFromTitle, (v) => { settings.nameFromTitle = v; settingsChanged(); }));
  card.appendChild(checkRow('Show AI model in header (Opus/Sonnet/…)', () => settings.showModel, (v) => { settings.showModel = v; settingsChanged(); panes.forEach(updateModelBadge); }));

  sec('Folders & links');
  card.appendChild(textRow('Projects folder', () => settings.projectsDir, (v) => { settings.projectsDir = v; saveGlobals(); }, '~/Developer', 'text', true));
  const fNote = document.createElement('div'); fNote.className = 'layout-empty';
  fNote.textContent = 'New terminals open here. Tip: also add quick commands like “cd ~/Developer” for your Claude/Codex folders.';
  card.appendChild(fNote);
  card.appendChild(checkRow('Open links in the app browser (not Chrome)', () => settings.openInApp, (v) => { settings.openInApp = v; settingsChanged(); }));

  sec('Usage bar');
  card.appendChild(checkRow('Show usage bar', () => settings.usageEnabled, (v) => { settings.usageEnabled = v; saveGlobals(); pollUsage(true); }));
  card.appendChild(textRow('Shell command', () => settings.usageCommand, (v) => { settings.usageCommand = v; saveGlobals(); pollUsage(true); }, 'ccusage --today'));

  sec('Voice (speech-to-text)');
  card.appendChild(textRow('STT key', () => voiceAI.sttKey, (v) => { voiceAI.sttKey = v; saveGlobals(); }, '', 'password'));
  card.appendChild(textRow('STT model', () => voiceAI.sttModel, (v) => { voiceAI.sttModel = v; saveGlobals(); }, ''));
  card.appendChild(textRow('STT endpoint', () => voiceAI.sttUrl, (v) => { voiceAI.sttUrl = v; saveGlobals(); }, ''));
  const sNote = document.createElement('div'); sNote.className = 'layout-empty';
  sNote.innerHTML = 'Click the mic to record, click again to send. Free Groq Whisper key: <a class="prefs-link" href="#" data-url="https://console.groq.com/keys">console.groq.com/keys</a>';
  card.appendChild(sNote);
  card.appendChild(checkRow('Also AI-clean speech into commands', () => voiceAI.enabled, (v) => { voiceAI.enabled = v; saveGlobals(); }));
  card.appendChild(textRow('AI key', () => voiceAI.apiKey, (v) => { voiceAI.apiKey = v; autoConfigAI(v); saveGlobals(); if (settings.autoName) setTimeout(() => autoNamePass(true), 400); }, 'paste a key — endpoint auto-detected', 'password'));
  card.appendChild(textRow('AI model', () => voiceAI.model, (v) => { voiceAI.model = v; saveGlobals(); }, ''));
  card.appendChild(textRow('AI endpoint', () => voiceAI.baseUrl, (v) => { voiceAI.baseUrl = v; saveGlobals(); }, ''));
  const vNote = document.createElement('div'); vNote.className = 'layout-empty';
  vNote.innerHTML = 'Same key powers auto-naming. Paste a Groq (gsk_…), OpenRouter (sk-or-…), Gemini (AIza…), or OpenAI (sk-…) key — endpoint sets itself. For Qwen: <a class="prefs-link" href="#" data-url="https://openrouter.ai/models/qwen/qwen3-235b-a22b">openrouter.ai Qwen3</a>. Stored locally.';
  card.appendChild(vNote);

  const actions = document.createElement('div'); actions.className = 'ob-actions';
  const toolkit = document.createElement('button'); toolkit.className = 'pop-custom';
  toolkit.innerHTML = lic('wrench') + '<span>Set up toolkit…</span>';
  toolkit.addEventListener('click', () => { ov.remove(); openOnboarding(); });
  const done = document.createElement('button'); done.className = 'pop-custom'; done.style.flex = '0 0 auto'; done.textContent = 'Done';
  done.addEventListener('click', () => ov.remove());
  actions.append(toolkit, done); card.appendChild(actions);

  // Open external links (Groq, Qwen, etc.) in the system browser
  card.addEventListener('click', (e) => {
    const a = e.target.closest('a.prefs-link');
    if (a) { e.preventDefault(); window.api.openExternal(a.dataset.url); }
  });

  document.body.appendChild(ov);
  renderIcons();
}

function openFeedback() {
  if (document.getElementById('feedback-modal')) return;
  const ov = document.createElement('div'); ov.id = 'feedback-modal';
  const card = document.createElement('div'); card.className = 'ob-card'; card.style.maxWidth = '440px';
  ov.appendChild(card);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });

  const head = document.createElement('div'); head.className = 'ob-head';
  head.innerHTML = lic('message-circle') + ' Share feedback';
  card.appendChild(head);
  const sub = document.createElement('div'); sub.className = 'ob-sub';
  sub.textContent = 'What\'s working well? What could be better? We read every note.';
  card.appendChild(sub);

  // Rating
  const ratingRow = document.createElement('div'); ratingRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:12px;';
  const ratingLbl = document.createElement('span'); ratingLbl.textContent = 'Rating:'; ratingLbl.style.fontWeight = '600';
  ratingRow.appendChild(ratingLbl);
  let rating = 0;
  const stars = [];
  [1, 2, 3, 4, 5].forEach((n) => {
    const s = document.createElement('button'); s.className = 'feedback-star'; s.textContent = '☆'; s.dataset.n = n;
    s.addEventListener('click', () => { rating = n; stars.forEach((st) => { st.textContent = +st.dataset.n <= n ? '★' : '☆'; st.classList.toggle('lit', +st.dataset.n <= n); }); });
    stars.push(s); ratingRow.appendChild(s);
  });
  card.appendChild(ratingRow);

  // Message
  const msgLbl = document.createElement('div'); msgLbl.textContent = 'Message'; msgLbl.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:4px;';
  card.appendChild(msgLbl);
  const ta = document.createElement('textarea'); ta.rows = 5;
  ta.placeholder = 'Tell us what you love, what\'s confusing, or what you\'d like to see next…';
  ta.style.cssText = 'width:100%;resize:vertical;background:var(--btn-bg);color:inherit;border:1px solid var(--pop-line);border-radius:8px;padding:8px;font:inherit;font-size:13px;box-sizing:border-box;';
  card.appendChild(ta);

  // Email
  const emailLbl = document.createElement('div'); emailLbl.textContent = 'Your email (optional)'; emailLbl.style.cssText = 'font-weight:600;font-size:13px;margin:10px 0 4px;';
  card.appendChild(emailLbl);
  const emailIn = document.createElement('input'); emailIn.type = 'email'; emailIn.placeholder = 'for follow-up questions';
  emailIn.style.cssText = 'width:100%;background:var(--btn-bg);color:inherit;border:1px solid var(--pop-line);border-radius:8px;padding:8px;font:inherit;font-size:13px;box-sizing:border-box;';
  card.appendChild(emailIn);

  const actions = document.createElement('div'); actions.className = 'ob-actions'; actions.style.marginTop = '16px';
  const cancel = document.createElement('button'); cancel.className = 'ob-skip'; cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => ov.remove());
  const send = document.createElement('button'); send.className = 'pop-custom'; send.style.flex = '0 0 auto';
  send.innerHTML = lic('send') + '<span>Send feedback</span>';
  send.addEventListener('click', async () => {
    const msg = ta.value.trim();
    if (!msg) { ta.focus(); return; }
    const body = (rating ? `Rating: ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}\n\n` : '') + msg + (emailIn.value.trim() ? `\n\nReply to: ${emailIn.value.trim()}` : '');
    // Copy to clipboard so the user always has a fallback
    try { await navigator.clipboard.writeText(`To: dev@launchindustries.biz\nSubject: DiscoVibe Feedback\n\n${body}`); } catch (_) {}
    // Try to open in email client
    window.api.openExternal(`mailto:dev@launchindustries.biz?subject=${encodeURIComponent('DiscoVibe Feedback')}&body=${encodeURIComponent(body)}`);
    // Show confirmation inside the card
    card.innerHTML = `<div class="ob-head">${lic('check-circle')} Thanks for the feedback!</div>
      <div class="ob-sub">Your email client should have opened. If not, the feedback was copied to your clipboard — paste it in an email to <b>dev@launchindustries.biz</b>.</div>
      <div class="ob-actions" style="margin-top:16px"><button class="pop-custom" style="flex:0 0 auto">Close</button></div>`;
    card.querySelector('button').addEventListener('click', () => ov.remove());
    renderIcons();
  });
  actions.append(cancel, send);
  card.appendChild(actions);

  document.body.appendChild(ov);
  renderIcons();
  setTimeout(() => ta.focus(), 60);
}

function openLayouts(anchor) {
  const c = document.createElement('div');
  const title = document.createElement('div'); title.className = 'pop-title'; title.textContent = 'Layouts';
  c.appendChild(title);

  const saveRow = document.createElement('div'); saveRow.className = 'layout-save';
  const input = document.createElement('input'); input.type = 'text'; input.placeholder = 'Layout name';
  const saveBtn = document.createElement('button'); saveBtn.className = 'pop-custom'; saveBtn.style.flex = '0 0 auto';
  saveBtn.innerHTML = lic('save') + '<span>Save</span>';
  const doSave = () => { const name = input.value.trim(); if (!name) return; saveNamedLayout(name); openLayouts(anchor); };
  saveBtn.addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
  saveRow.append(input, saveBtn);
  c.appendChild(saveRow);

  const list = document.createElement('div'); list.className = 'layout-list';
  const layouts = loadLayouts();
  const names = Object.keys(layouts);
  if (!names.length) {
    const empty = document.createElement('div'); empty.className = 'layout-empty';
    empty.textContent = 'No saved layouts yet. Name one and Save.';
    list.appendChild(empty);
  } else {
    names.forEach((name) => {
      const row = document.createElement('div'); row.className = 'layout-row';
      const ln = document.createElement('span'); ln.className = 'lname'; ln.textContent = name;
      const apply = document.createElement('button'); apply.innerHTML = lic('play') + '<span>Apply</span>';
      apply.addEventListener('click', () => { applyNamedLayout(name); closePopover(); });
      const del = document.createElement('button'); del.innerHTML = lic('trash-2');
      del.title = 'Delete'; del.addEventListener('click', () => { deleteNamedLayout(name); openLayouts(anchor); });
      row.append(ln, apply, del);
      list.appendChild(row);
    });
  }
  c.appendChild(list);
  openPopover(anchor, c);
}

function openTilePicker(anchor) {
  const c = document.createElement('div');
  const title = document.createElement('div'); title.className = 'pop-title'; title.textContent = 'Tile theme';
  c.appendChild(title);
  const makeRow = (name, palette) => {
    const row = document.createElement('div'); row.className = 'theme-row';
    if ((name === 'Auto' && !tileTheme) || name === tileTheme) row.classList.add('current');
    const tn = document.createElement('span'); tn.className = 'tname'; tn.textContent = name;
    const sw = document.createElement('span'); sw.className = 'theme-swatches';
    palette.slice(0, 6).forEach((col) => { const i = document.createElement('i'); i.style.background = col; sw.appendChild(i); });
    row.append(tn, sw);
    row.addEventListener('click', () => { applyTileTheme(name === 'Auto' ? '' : name); closePopover(); });
    return row;
  };
  c.appendChild(makeRow('Auto', activePaletteForMode()));
  Object.keys(TILE_THEMES).forEach((name) => c.appendChild(makeRow(name, TILE_THEMES[name])));
  const note = document.createElement('div'); note.className = 'layout-empty';
  note.textContent = 'Applies to terminals you open next.';
  c.appendChild(note);
  openPopover(anchor, c);
}
function activePaletteForMode() { return themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE; }
function setTileTheme(name, fromRemote) {
  tileTheme = name || '';
  const btn = document.getElementById('btn-tiles');
  setBtnIcon(btn, 'palette', tileTheme || 'Tiles');
  applyThemeBorder();
  if (!fromRemote) { saveGlobals(); window.api.broadcast({ type: 'tileTheme', value: tileTheme }); }
}
// Recolor every existing terminal to the named theme's palette.
function reskinAll(name) {
  const pal = TILE_THEMES[name];
  if (!pal) return;
  [...panes, ...stored].forEach((p, idx) => applyColor(p, pal[idx % pal.length]));
  renderTray();
  scheduleSave();
}
// User picked a theme: set it AND reskin current terminals (and other windows).
function applyTileTheme(name) {
  setTileTheme(name);
  if (name) { reskinAll(name); window.api.broadcast({ type: 'reskin', value: name }); }
}
// Window frame color follows the active tile theme (or the chrome accent in Auto).
function applyThemeBorder() {
  const color = THEME_ACCENTS[tileTheme] || (themeMode === 'light' ? '#2f6fe0' : '#5b9dff');
  document.documentElement.style.setProperty('--theme-border', color);
}

// Recently closed terminals (reopen recreates a fresh shell with same name/color/url).
const CLOSED_KEY = 'tileterm.closed.v1';
function loadClosed() { try { return JSON.parse(localStorage.getItem(CLOSED_KEY)) || []; } catch (_) { return []; } }
function saveClosed(list) { try { localStorage.setItem(CLOSED_KEY, JSON.stringify(list.slice(0, 12))); } catch (_) {} }
function recordClosed(pane) {
  const list = loadClosed();
  list.unshift({
    name: pane.nameInput.value || pane.name,
    color: pane.color,
    webUrl: pane.webUrl || '',
    cwd: pane.cwd || '',
    transcript: pane.transcript || '',
    closedAt: Date.now()
  });
  saveClosed(list);
}
function reopenClosed(entry) {
  const list = loadClosed();
  const cfg = entry || list.shift();
  if (!cfg) { flashMsg('No recently closed terminals'); return; }
  if (entry) { const i = list.findIndex((e) => e === entry); if (i >= 0) list.splice(i, 1); }
  saveClosed(list);
  addPane({ name: cfg.name, color: cfg.color, webUrl: cfg.webUrl, cwd: cfg.cwd });
}

// ===========================================================================
// Session recovery — every terminal's output is mirrored to disk by the main
// process, so a pane closed by accident (or lost to a crash/quit) can still be
// read, searched, saved, and reopened in the same directory. Cmd+Shift+R.
// ===========================================================================
function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} hr ago`;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtSize(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

async function openRecovery() {
  if (document.getElementById('recover')) return;
  const ov = document.createElement('div'); ov.id = 'recover';
  const card = document.createElement('div'); card.className = 'ob-card'; card.style.maxWidth = '760px';
  ov.appendChild(card);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape' && document.getElementById('recover')) { close(); document.removeEventListener('keydown', esc); }
  });

  const head = document.createElement('div'); head.className = 'ob-head';
  head.innerHTML = lic('history') + ' Recover a session';
  const sub = document.createElement('div'); sub.className = 'ob-sub';
  sub.textContent = 'Every terminal is recorded as it runs. Closed one by accident? Read it back here, save it, or reopen a terminal in the same folder.';
  card.append(head, sub);

  const search = document.createElement('input'); search.type = 'search';
  search.placeholder = 'Search names, folders, and output…';
  search.style.cssText = 'width:100%;background:var(--btn-bg);color:inherit;border:1px solid var(--pop-line);border-radius:8px;padding:8px;font:inherit;font-size:13px;box-sizing:border-box;margin-bottom:10px;';
  card.appendChild(search);

  const list = document.createElement('div'); list.className = 'rec-list';
  card.appendChild(list);

  const actions = document.createElement('div'); actions.className = 'ob-actions';
  const done = document.createElement('button'); done.className = 'ob-skip'; done.textContent = 'Close';
  done.addEventListener('click', close);
  actions.appendChild(done);
  card.appendChild(actions);

  document.body.appendChild(ov);
  renderIcons();

  let sessions = [];
  try { sessions = await window.api.listTranscripts(); } catch (_) {}

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const shown = sessions.filter((s) => !q
      || (s.name || '').toLowerCase().includes(q)
      || (s.cwd || '').toLowerCase().includes(q)
      || (s.preview || '').toLowerCase().includes(q));
    list.innerHTML = '';
    if (!shown.length) {
      const empty = document.createElement('div'); empty.className = 'layout-empty';
      empty.textContent = sessions.length ? 'Nothing matches that search.' : 'No recorded sessions yet. New terminals are recorded from now on.';
      list.appendChild(empty);
      return;
    }
    for (const s of shown) {
      const row = document.createElement('div'); row.className = 'rec-row';
      if (s.color) row.style.setProperty('--rec-color', s.color);

      const info = document.createElement('div'); info.className = 'rec-info';
      const title = document.createElement('div'); title.className = 'rec-name';
      title.textContent = s.name || 'Terminal';
      if (s.active) { const b = document.createElement('span'); b.className = 'rec-live'; b.textContent = 'recording'; title.appendChild(b); }
      const meta = document.createElement('div'); meta.className = 'rec-meta';
      meta.textContent = [fmtWhen(s.started), s.cwd || '', fmtSize(s.size)].filter(Boolean).join('  ·  ');
      const prev = document.createElement('div'); prev.className = 'rec-prev';
      prev.textContent = s.preview || '(no output captured)';
      info.append(title, meta, prev);

      const btns = document.createElement('div'); btns.className = 'rec-btns';
      const view = document.createElement('button'); view.innerHTML = lic('file-text') + '<span>View</span>';
      view.addEventListener('click', () => viewTranscript(s));
      const reopen = document.createElement('button'); reopen.innerHTML = lic('rotate-ccw') + '<span>Reopen here</span>';
      reopen.title = s.cwd ? 'New terminal in ' + s.cwd : 'New terminal';
      reopen.addEventListener('click', () => { addPane({ name: s.name, color: s.color, cwd: s.cwd }); close(); });
      const save = document.createElement('button'); save.innerHTML = lic('save') + '<span>Save…</span>';
      save.addEventListener('click', async () => {
        const r = await window.api.readTranscript(s.base);
        if (!r || !r.ok) { flashMsg('Could not read transcript'); return; }
        const w = await window.api.saveOutput(s.name || 'session', r.text);
        if (w && w.ok) flashMsg('Saved ✓');
      });
      const del = document.createElement('button'); del.innerHTML = lic('trash-2');
      del.title = 'Delete this transcript';
      del.addEventListener('click', async () => {
        if (!confirm(`Delete the saved transcript for "${s.name || 'Terminal'}"? This can't be undone.`)) return;
        await window.api.deleteTranscript(s.base);
        sessions = sessions.filter((x) => x.base !== s.base);
        render();
      });
      btns.append(view, reopen, save, del);

      row.append(info, btns);
      list.appendChild(row);
    }
    renderIcons();
  };
  search.addEventListener('input', render);
  render();
  setTimeout(() => search.focus(), 60);
}

// Read a recorded session back, with select-all + copy that actually work.
async function viewTranscript(s) {
  const r = await window.api.readTranscript(s.base);
  if (!r || !r.ok) { flashMsg('Could not read transcript'); return; }
  const ov = document.createElement('div'); ov.id = 'recover';
  const card = document.createElement('div'); card.className = 'ob-card'; card.style.maxWidth = '900px';
  ov.appendChild(card);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

  const head = document.createElement('div'); head.className = 'ob-head';
  head.innerHTML = lic('file-text') + ' ' + (s.name || 'Session');
  const sub = document.createElement('div'); sub.className = 'ob-sub';
  sub.textContent = [fmtWhen(s.started), s.cwd || '', r.truncated ? 'showing the last 4 MB' : ''].filter(Boolean).join('  ·  ');
  card.append(head, sub);

  const pre = document.createElement('pre'); pre.className = 'rec-body';
  pre.textContent = r.text;
  card.appendChild(pre);

  const actions = document.createElement('div'); actions.className = 'ob-actions';
  const back = document.createElement('button'); back.className = 'ob-skip'; back.textContent = 'Close';
  back.addEventListener('click', close);
  const copyAll = document.createElement('button'); copyAll.className = 'pop-custom'; copyAll.style.flex = '0 0 auto';
  copyAll.innerHTML = lic('clipboard') + '<span>Copy all</span>';
  copyAll.addEventListener('click', () => {
    navigator.clipboard.writeText(r.text).then(() => { pushClip(r.text); flashMsg('Copied ✓'); }).catch(() => flashMsg('Copy failed'));
  });
  actions.append(back, copyAll);
  card.appendChild(actions);

  document.body.appendChild(ov);
  renderIcons();
  pre.scrollTop = pre.scrollHeight;
}

// Clipboard history — remembers the last 10 things you copied.
const CLIPS_KEY = 'tileterm.clips.v1';
function loadClips() { try { return JSON.parse(localStorage.getItem(CLIPS_KEY)) || []; } catch (_) { return []; } }
function saveClips(l) { try { localStorage.setItem(CLIPS_KEY, JSON.stringify(l.slice(0, 10))); } catch (_) {} }
function pushClip(text) {
  text = (text || '').trim(); if (!text) return;
  const l = loadClips();
  const i = l.indexOf(text); if (i >= 0) l.splice(i, 1);
  l.unshift(text); saveClips(l);
}
document.addEventListener('copy', () => {
  setTimeout(() => {
    try {
      const sel = (window.getSelection && window.getSelection().toString()) || '';
      const fp = panes.find((p) => p.id === focusedId);
      const t = sel || (fp && fp.term.hasSelection && fp.term.hasSelection() ? fp.term.getSelection() : '');
      pushClip(t);
    } catch (_) {}
  }, 30);
});
function openClips(anchor) {
  const c = document.createElement('div');
  const title = document.createElement('div'); title.className = 'pop-title'; title.textContent = 'Clipboard history (last 10)';
  c.appendChild(title);
  const list = loadClips();
  const listEl = document.createElement('div'); listEl.className = 'layout-list';
  if (!list.length) {
    const empty = document.createElement('div'); empty.className = 'layout-empty';
    empty.textContent = 'Nothing copied yet. Copy text (⌘C) and it shows here.';
    listEl.appendChild(empty);
  } else {
    list.forEach((clip, idx) => {
      const row = document.createElement('div'); row.className = 'layout-row';
      const paste = document.createElement('button'); paste.style.flex = '1 1 auto'; paste.style.justifyContent = 'flex-start';
      const oneLine = clip.replace(/\s+/g, ' ').slice(0, 48);
      paste.innerHTML = lic('clipboard') + `<span style="font-family:ui-monospace,Menlo,monospace">${oneLine.replace(/</g, '&lt;')}</span>`;
      paste.title = 'Paste into focused terminal (and copy to clipboard)';
      paste.addEventListener('click', () => {
        const pane = panes.find((p) => p.id === focusedId) || panes[0];
        if (pane) { window.api.input(pane.id, clip); pane.term.focus(); }
        try { navigator.clipboard.writeText(clip); } catch (_) {}
        closePopover();
      });
      const del = document.createElement('button'); del.innerHTML = lic('trash-2'); del.title = 'Remove';
      del.addEventListener('click', () => { const l = loadClips(); l.splice(idx, 1); saveClips(l); openClips(anchor); });
      row.append(paste, del);
      listEl.appendChild(row);
    });
  }
  c.appendChild(listEl);
  openPopover(anchor, c);
}

const COMMANDS_KEY = 'tileterm.commands.v1';
const DEFAULT_COMMANDS = [
  'claude',           // Claude Code (Anthropic)
  'codex',            // Codex CLI (OpenAI)
  'aider',            // Aider (open-source AI coding)
  'gemini',           // Gemini CLI (Google)
  '/compact',         // Claude Code: compact context
  '/clear',           // Claude Code: clear conversation
  'ccusage --today',  // Claude token usage today
  'What are we working on? Briefly recap our current task and what to do next.',
  'Please remember what we\'ve been working on and save it to memory',
  'Please save a resume note: what we built today and what to work on next',
  'clear',            // Clear terminal screen
];
function loadCommands() {
  try {
    const stored = localStorage.getItem(COMMANDS_KEY);
    if (stored === null) return DEFAULT_COMMANDS.slice();   // first run: pre-seed
    return JSON.parse(stored) || [];
  } catch (_) { return []; }
}
function saveCommands(list) { try { localStorage.setItem(COMMANDS_KEY, JSON.stringify(list.slice(0, 15))); } catch (_) {} }
function runCommand(cmd) {
  const pane = panes.find((p) => p.id === focusedId) || panes[0];
  if (!pane) return;
  // Confirm before destructive clear commands so the user doesn't lose context by accident.
  const isClear = /^\/?(clear|reset)$/i.test(cmd.trim());
  if (isClear && !window.confirm(`Run "${cmd}" in the focused terminal?`)) return;
  window.api.input(pane.id, cmd + '\r');
  pane.lastActivity = Date.now();
  pane.term.focus();
}
const AI_COMMAND_GROUPS = [
  {
    id: 'claude', name: 'Claude Code', color: '#b86bd8',
    commands: [
      { label: 'Launch',               cmd: 'claude' },
      { label: 'Install / update',     cmd: 'npm install -g @anthropic-ai/claude-code' },
      { label: 'Compact context',      cmd: '/compact' },
      { label: 'Clear conversation',   cmd: '/clear' },
      { label: 'Show memory',          cmd: '/memory' },
      { label: 'Review changes',       cmd: '/review' },
      { label: 'Health check',         cmd: '/doctor' },
      { label: "Today's usage",        cmd: 'ccusage --today' },
    ]
  },
  {
    id: 'codex', name: 'Codex CLI', color: '#10a37f',
    commands: [
      { label: 'Launch',               cmd: 'codex' },
      { label: 'Install / update',     cmd: 'npm install -g @openai/codex' },
      { label: 'Full auto mode',       cmd: 'codex --approval-mode full-auto' },
      { label: 'Ask (non-interactive)',cmd: 'codex -q ""' },
    ]
  },
  {
    id: 'aider', name: 'Aider', color: '#3fb6a8',
    commands: [
      { label: 'Launch',               cmd: 'aider' },
      { label: 'Install (pip)',        cmd: 'pip install aider-chat' },
      { label: 'Install (brew)',       cmd: 'brew install aider' },
      { label: 'Launch with Claude',   cmd: 'aider --model claude-sonnet-4-5' },
      { label: 'Add files to context', cmd: '/add' },
      { label: 'Undo last change',     cmd: '/undo' },
      { label: 'Clear history',        cmd: '/clear' },
      { label: 'Show diff',            cmd: '/diff' },
    ]
  },
  {
    id: 'kiro', name: 'Kiro', color: '#FF9900',
    commands: [
      { label: 'Launch',               cmd: 'kiro-cli' },
      { label: 'Install / update',     cmd: 'brew install --cask kiro-cli' },
      { label: 'Open current folder',  cmd: 'kiro-cli .' },
      { label: 'Health check',         cmd: 'kiro-cli doctor' },
    ]
  },
  {
    id: 'gemini', name: 'Gemini CLI', color: '#4285F4',
    commands: [
      { label: 'Launch',               cmd: 'gemini' },
      { label: 'Install / update',     cmd: 'npm install -g @google/gemini-cli' },
      { label: 'Non-interactive prompt', cmd: 'gemini -p ""' },
      { label: 'Clear conversation',   cmd: '/clear' },
      { label: 'Help',                 cmd: '/help' },
    ]
  },
  {
    id: 'vercel', name: 'Vercel CLI', color: '#0070f3',
    commands: [
      { label: 'Deploy (preview)',     cmd: 'vercel' },
      { label: 'Deploy (production)',  cmd: 'vercel --prod' },
      { label: 'Install / update',     cmd: 'npm install -g vercel' },
      { label: 'Login',                cmd: 'vercel login' },
      { label: 'Dev server',           cmd: 'vercel dev' },
      { label: 'Pull env vars',        cmd: 'vercel env pull' },
      { label: 'View logs',            cmd: 'vercel logs' },
      { label: 'List deployments',     cmd: 'vercel ls' },
    ]
  },
];

// ===========================================================================
// Remote tool definitions — Monica can update tools.json on GitHub to fix
// commands for ALL users without shipping a new build.
// ===========================================================================
const REMOTE_TOOLS_URL = 'https://raw.githubusercontent.com/Launch-Industries/DiscoVibe/main/tools.json';
const REMOTE_TOOLS_KEY = 'discovibe.remote-tools.v1';

function applyRemoteTools(data) {
  if (!data || typeof data !== 'object') return;
  // Patch INSTALL_TOOLS entries
  if (data.tools && typeof data.tools === 'object') {
    for (const [id, patch] of Object.entries(data.tools)) {
      const t = INSTALL_TOOLS.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    }
  }
  // Patch AI_COMMAND_GROUPS entries
  if (data.command_groups && typeof data.command_groups === 'object') {
    for (const [id, patch] of Object.entries(data.command_groups)) {
      const g = AI_COMMAND_GROUPS.find((x) => x.id === id);
      if (g && patch.commands) g.commands = patch.commands;
      if (g && patch.color) g.color = patch.color;
    }
  }
}

// Apply cached remote tools immediately (synchronous, before any UI renders)
try {
  const cached = localStorage.getItem(REMOTE_TOOLS_KEY);
  if (cached) applyRemoteTools(JSON.parse(cached));
} catch (_) {}

// Fetch fresh remote tools in the background — update cache if version changed
async function fetchRemoteTools() {
  try {
    const res = await fetch(REMOTE_TOOLS_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || typeof data.version !== 'number') return;
    const cached = localStorage.getItem(REMOTE_TOOLS_KEY);
    const prev = cached ? JSON.parse(cached) : null;
    if (!prev || data.version > prev.version) {
      localStorage.setItem(REMOTE_TOOLS_KEY, JSON.stringify(data));
      applyRemoteTools(data);
      console.log('[DiscoVibe] Updated tool definitions to version', data.version);
    }
  } catch (_) {}   // network offline or file missing — use hardcoded defaults
}

// Track which AI sections the user has expanded so they stay open on re-render
const cmdGroupOpen = {};

function openCommands(anchor) {
  const c = document.createElement('div');
  c.style.minWidth = '340px';

  // ── My commands (top) ────────────────────────────────────────────────────
  const myHdr = document.createElement('div'); myHdr.className = 'pop-title';
  myHdr.textContent = 'My commands';
  c.appendChild(myHdr);

  const addRow = document.createElement('div'); addRow.className = 'layout-save';
  const input = document.createElement('input'); input.type = 'text'; input.placeholder = 'e.g. cd ~/Developer'; input.spellcheck = false;
  const addBtn = document.createElement('button'); addBtn.className = 'pop-custom'; addBtn.style.flex = '0 0 auto';
  addBtn.innerHTML = lic('plus') + '<span>Add</span>';
  const doAdd = () => {
    const v = input.value.trim(); if (!v) return;
    const list = loadCommands();
    if (!list.includes(v)) { list.unshift(v); saveCommands(list); }
    openCommands(anchor);
  };
  addBtn.addEventListener('click', doAdd);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
  addRow.append(input, addBtn);
  c.appendChild(addRow);

  const list = loadCommands();
  const listEl = document.createElement('div'); listEl.className = 'layout-list';
  if (!list.length) {
    const empty = document.createElement('div'); empty.className = 'layout-empty';
    empty.textContent = 'No saved commands. Add one above.';
    listEl.appendChild(empty);
  } else {
    list.forEach((cmd, idx) => {
      const row = document.createElement('div'); row.className = 'layout-row';
      const run = document.createElement('button');
      run.style.flex = '1 1 auto'; run.style.justifyContent = 'flex-start'; run.style.overflow = 'hidden';
      run.innerHTML = lic('terminal') + `<span style="font-family:ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cmd.replace(/</g, '&lt;')}</span>`;
      run.title = 'Run in focused terminal';
      run.addEventListener('click', () => { runCommand(cmd); closePopover(); });
      const up = document.createElement('button'); up.innerHTML = lic('chevron-up'); up.title = 'Move up'; up.disabled = idx === 0;
      up.addEventListener('click', () => { const l = loadCommands(); l.splice(idx - 1, 0, l.splice(idx, 1)[0]); saveCommands(l); openCommands(anchor); });
      const dn = document.createElement('button'); dn.innerHTML = lic('chevron-down'); dn.title = 'Move down'; dn.disabled = idx === list.length - 1;
      dn.addEventListener('click', () => { const l = loadCommands(); l.splice(idx + 1, 0, l.splice(idx, 1)[0]); saveCommands(l); openCommands(anchor); });
      const del = document.createElement('button'); del.innerHTML = lic('trash-2'); del.title = 'Remove';
      del.addEventListener('click', () => { const l = loadCommands(); l.splice(idx, 1); saveCommands(l); openCommands(anchor); });
      row.append(run, up, dn, del);
      listEl.appendChild(row);
    });
  }
  c.appendChild(listEl);

  // ── AI tool sections ─────────────────────────────────────────────────────
  const aiHdr = document.createElement('div'); aiHdr.className = 'pop-title'; aiHdr.style.marginTop = '12px';
  aiHdr.textContent = 'AI tools';
  c.appendChild(aiHdr);

  AI_COMMAND_GROUPS.forEach((group) => {
    const isOpen = !!cmdGroupOpen[group.id];

    const header = document.createElement('div'); header.className = 'cmd-group-hd';
    if (isOpen) header.classList.add('open');
    const dot = document.createElement('span'); dot.className = 'cmd-group-dot'; dot.style.background = group.color;
    const nameEl = document.createElement('span'); nameEl.textContent = group.name; nameEl.style.flex = '1 1 auto';
    const chev = document.createElement('i'); chev.setAttribute('data-lucide', 'chevron-right'); chev.className = 'cmd-chevron';
    header.append(dot, nameEl, chev);

    const body = document.createElement('div'); body.className = 'cmd-group-body';
    body.style.display = isOpen ? 'flex' : 'none';   // use style.display, not hidden attr

    group.commands.forEach(({ label, cmd }) => {
      const row = document.createElement('button'); row.className = 'cmd-item'; row.title = cmd;
      const lblEl = document.createElement('span'); lblEl.className = 'cmd-item-lbl'; lblEl.textContent = label;
      const cmdEl = document.createElement('span'); cmdEl.className = 'cmd-item-cmd'; cmdEl.textContent = cmd;
      row.append(lblEl, cmdEl);
      row.addEventListener('click', () => { runCommand(cmd); closePopover(); });
      body.appendChild(row);
    });

    header.addEventListener('click', () => {
      const opening = body.style.display === 'none';
      body.style.display = opening ? 'flex' : 'none';
      cmdGroupOpen[group.id] = opening;
      header.classList.toggle('open', opening);
      renderIcons();
    });

    c.append(header, body);
  });

  // ── Recently closed ──────────────────────────────────────────────────────
  const closed = loadClosed();
  const rcTitle = document.createElement('div'); rcTitle.className = 'pop-title'; rcTitle.style.marginTop = '10px';
  rcTitle.textContent = 'Recently closed  ·  ⌘⇧T';
  c.appendChild(rcTitle);
  const rcList = document.createElement('div'); rcList.className = 'layout-list';
  if (!closed.length) {
    const empty = document.createElement('div'); empty.className = 'layout-empty'; empty.textContent = 'Nothing closed yet.';
    rcList.appendChild(empty);
  } else {
    closed.forEach((entry) => {
      const row = document.createElement('div'); row.className = 'layout-row';
      const dot = document.createElement('span');
      dot.style.cssText = `width:14px;height:14px;border-radius:4px;flex:0 0 auto;background:${entry.color};box-shadow:0 0 0 1px rgba(0,0,0,.4)`;
      const reopen = document.createElement('button'); reopen.style.flex = '1 1 auto'; reopen.style.justifyContent = 'flex-start';
      reopen.innerHTML = lic('rotate-ccw') + `<span>${(entry.name || 'Terminal').replace(/</g, '&lt;')}</span>`;
      reopen.title = 'Reopen (fresh shell, same name/color)';
      reopen.addEventListener('click', () => { reopenClosed(entry); closePopover(); });
      row.append(dot, reopen);
      rcList.appendChild(row);
    });
  }
  c.appendChild(rcList);

  openPopover(anchor, c);
}

// ===========================================================================
// Persistence
// ===========================================================================
const GLOBALS_KEY = 'tileterm.globals.v1';
const SESSION_KEY = 'tileterm.session.v1:' + WIN_KEY;   // per-window so every monitor restores
const LAYOUTS_KEY = 'tileterm.layouts.v1';

function paneConfig(p, collapsed) {
  return { name: p.nameInput.value || p.name, color: p.color, bellOn: p.bellOn,
    webUrl: p.webUrl || '', note: p.note || '', manual: !!p.manualName, collapsed: !!collapsed,
    cwd: p.cwd || '', aiName: p.aiName || '' };
}
function serializePanes() {
  return [...panes.map((p) => paneConfig(p, false)), ...stored.map((p) => paneConfig(p, true))];
}
function saveGlobals() {
  try { localStorage.setItem(GLOBALS_KEY, JSON.stringify({ themeMode, globalTitleSize, globalFontSize, globalFontFamily, globalTitleCenter, soundMuted, settings, tileTheme, voiceAI })); } catch (_) {}
}
let saveTimer = null;
function writeSession() {
  try {
    const data = serializePanes();
    localStorage.setItem(SESSION_KEY, JSON.stringify({ panes: data }));
    // Keep a backup of the last NON-EMPTY layout so an empty/failed state can't erase it.
    if (data.length) localStorage.setItem(SESSION_KEY + ':bak', JSON.stringify({ panes: data }));
  } catch (_) {}
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSession, 400);
}
function loadGlobals() { try { return JSON.parse(localStorage.getItem(GLOBALS_KEY)); } catch (_) { return null; } }
function loadSession() {
  const tryKey = (k) => { try { const s = JSON.parse(localStorage.getItem(k)); return (s && Array.isArray(s.panes) && s.panes.length) ? s : null; } catch (_) { return null; } };
  // Current → backup → (primary only) the legacy un-suffixed key.
  return tryKey(SESSION_KEY)
    || tryKey(SESSION_KEY + ':bak')
    || (WIN_KEY === 'primary' ? tryKey('tileterm.session.v1') : null);
}
function loadLayouts() { try { return JSON.parse(localStorage.getItem(LAYOUTS_KEY)) || {}; } catch (_) { return {}; } }
function saveNamedLayout(name) {
  const all = loadLayouts();
  all[name] = { panes: serializePanes(), globalTitleSize, themeMode };
  try { localStorage.setItem(LAYOUTS_KEY, JSON.stringify(all)); } catch (_) {}
}
function deleteNamedLayout(name) { const all = loadLayouts(); delete all[name]; try { localStorage.setItem(LAYOUTS_KEY, JSON.stringify(all)); } catch (_) {} }
function applyNamedLayout(name) {
  const all = loadLayouts(); const layout = all[name]; if (!layout) return;
  // Tear down current (don't pollute recently-closed with a layout switch)
  [...panes].forEach((p) => closePane(p.id, true));
  [...stored].forEach((p) => closeStored(p, true));
  panes.length = 0; stored.length = 0;
  if (typeof layout.themeMode === 'string') applyThemeMode(layout.themeMode);
  if (typeof layout.globalTitleSize === 'number') globalTitleSize = layout.globalTitleSize;
  restoreConfigs(layout.panes || []);
}
function restoreConfigs(list) {
  if (!list.length) { addPane(); return; }
  list.forEach((cfg) => {
    try {
      const p = createPane(cfg);
      if (p && cfg.collapsed) collapsePane(p, true);
    } catch (err) { console.log('restore pane failed:', err && err.message); }
  });
  // If restore produced nothing usable, fall back to a fresh pane rather than a blank window.
  if (!panes.length && !stored.length) addPane();
  applyGlobalTitleSize(globalTitleSize, true);
  relayout();
  const first = panes[0];
  if (first) { setFocused(first.id); setTimeout(() => first.term.focus(), 40); }
  scheduleSave();
  // After layout settles, show resume banners for any panes with saved AI sessions
  setTimeout(() => panes.forEach(maybeShowResumeBanner), 300);
}

// ===========================================================================
// Theme / mute / settings application
// ===========================================================================
const themeBtn = document.getElementById('btn-theme');
function applyThemeMode(mode, fromRemote) {
  themeMode = mode;
  document.body.classList.toggle('light', mode === 'light');
  setBtnIcon(themeBtn, mode === 'light' ? 'sun' : 'moon', mode === 'light' ? 'Light' : 'Dark');
  applyThemeBorder();
  if (!fromRemote) { saveGlobals(); window.api.broadcast({ type: 'theme', value: mode }); }
}
const muteBtn = document.getElementById('btn-mute');
function refreshMuteBtn() { setBtnIcon(muteBtn, soundMuted ? 'volume-x' : 'volume-2', soundMuted ? 'Muted' : 'Bell on'); muteBtn.classList.toggle('muted', soundMuted); }
function setMute(on, fromRemote) { soundMuted = on; refreshMuteBtn(); if (!fromRemote) { saveGlobals(); window.api.broadcast({ type: 'mute', value: on }); } }
function applySettings() {
  document.body.classList.toggle('dim-inactive', settings.dimInactive);
  document.documentElement.style.setProperty('--dim-level', String(settings.dimLevel));
  document.body.classList.toggle('disco', settings.disco);
}

// ===========================================================================
// PTY data dispatch
// ===========================================================================
window.api.onData(({ id, data }) => {
  const pane = panes.find((p) => p.id === id) || stored.find((p) => p.id === id);
  if (pane) { pane.term.write(data); pane.lastActivity = Date.now(); }
});
window.api.onExit(({ id }) => {
  const pane = panes.find((p) => p.id === id) || stored.find((p) => p.id === id);
  if (!pane) return;
  pane.term.writeln('\r\n\x1b[90m[process exited — press any key to close]\x1b[0m');
  // Save resume entry when an AI tool session ends
  if (pane.detectedTool && pane.cwd) {
    const resume = loadResume();
    resume[pane.cwd] = {
      tool: pane.detectedTool,
      cmd: buildResumeCmd(pane.detectedTool, pane.cwd),
      cwd: pane.cwd,
      name: pane.nameInput ? (pane.nameInput.value || pane.name) : pane.name,
      timestamp: Date.now(),
    };
    saveResume(resume);
  }
  const off = pane.term.onData(() => { off.dispose(); if (pane.collapsed) closeStored(pane); else closePane(id); });
});

// ===========================================================================
// Voice mode
// ===========================================================================
// Voice = click to record, click again to stop + transcribe. Web Speech is unreliable in
// Electron, so we capture mic audio and send it to a transcription API (free Groq Whisper).
let mediaRecorder = null, mediaStream = null, audioChunks = [], voiceOn = false;
const voiceBtn = document.getElementById('btn-voice');

function typeToPane(text, withEnter) {
  const pane = panes.find((p) => p.id === focusedId) || panes[0];
  if (!pane || !text) return;
  window.api.input(pane.id, text + (withEnter ? '\r' : ''));
  pane.lastActivity = Date.now();
}
async function aiCleanCommand(text) {
  const res = await fetch(voiceAI.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + voiceAI.apiKey,
      'HTTP-Referer': 'https://launchindustries.biz',
      'X-Title': 'DiscoVibe'
    },
    body: JSON.stringify({
      model: voiceAI.model,
      temperature: 0.2,
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'You convert dictated speech into a single shell command for macOS zsh. Output ONLY the command on one line — no markdown, no backticks, no explanation. Fix obvious speech-to-text artifacts (e.g. "tilde"→~, "slash"→/, "dot"→., "dash"→-, spelled-out paths). If the text is clearly not a command, output it cleaned up as plain text.' },
        { role: 'user', content: text }
      ]
    })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  let out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
  out = out.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();   // strip stray fences
  return out;
}
function handleTranscript(raw) {
  const text = (raw || '').trim();
  if (!text) return;
  if (voiceAI.enabled && voiceAI.apiKey) {
    aiCleanCommand(text)
      .then((cmd) => typeToPane(cmd || text))
      .catch((err) => { console.log('voice AI error:', err.message); typeToPane(text + ' '); });
  } else {
    typeToPane(text + ' ');
  }
}

function cleanupStream() { if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; } }
async function startVoice() {
  if (!voiceAI.sttKey) {
    setBtnIcon(voiceBtn, 'mic-off', 'Voice: setup');
    voiceBtn.title = 'Add a free transcription key in Settings → Voice (Groq Whisper)';
    flashMsg('Add a Voice key in Settings'); return;
  }
  try { mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (err) { console.log('mic error:', err); setBtnIcon(voiceBtn, 'mic-off', 'Mic blocked'); flashMsg('Microphone blocked'); return; }
  audioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) audioChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(audioChunks, { type: (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm' });
    cleanupStream();
    if (blob.size) transcribeBlob(blob);
  };
  mediaRecorder.start();
  voiceOn = true; voiceBtn.classList.add('live'); setBtnIcon(voiceBtn, 'mic', '● Click to send');
}
function stopVoice() {
  voiceOn = false; voiceBtn.classList.remove('live');
  if (mediaRecorder && mediaRecorder.state !== 'inactive') { setBtnIcon(voiceBtn, 'mic', 'Transcribing…'); try { mediaRecorder.stop(); } catch (_) {} }
  else setBtnIcon(voiceBtn, 'mic', 'Voice');
}
async function transcribeBlob(blob) {
  try {
    const fd = new FormData();
    fd.append('file', blob, 'audio.webm');
    fd.append('model', voiceAI.sttModel);
    const res = await fetch(voiceAI.sttUrl, { method: 'POST', headers: { 'Authorization': 'Bearer ' + voiceAI.sttKey }, body: fd });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    setBtnIcon(voiceBtn, 'mic', 'Voice');
    if (j && j.text) handleTranscript(j.text);
  } catch (err) { console.log('STT error:', err); setBtnIcon(voiceBtn, 'mic', 'Voice'); flashMsg('Voice failed: ' + err.message); }
}
voiceBtn.addEventListener('click', () => { if (voiceOn) stopVoice(); else startVoice(); });

// ===========================================================================
// Toolbar + menu + displays
// ===========================================================================
const addCountEl = document.getElementById('add-count');
function readCount() { const n = parseInt(addCountEl.value, 10); return isNaN(n) || n < 1 ? 1 : Math.min(n, MAX_TERMINALS); }
document.getElementById('btn-add').addEventListener('click', () => addMany(readCount()));
addCountEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') addMany(readCount()); });
document.getElementById('btn-tiles').addEventListener('click', (e) => openTilePicker(e.currentTarget));
document.getElementById('btn-commands').addEventListener('click', (e) => openCommands(e.currentTarget));
document.getElementById('btn-clips').addEventListener('click', (e) => openClips(e.currentTarget));
themeBtn.addEventListener('click', () => applyThemeMode(themeMode === 'light' ? 'dark' : 'light'));
muteBtn.addEventListener('click', () => setMute(!soundMuted));
document.getElementById('btn-layouts').addEventListener('click', (e) => openLayouts(e.currentTarget));
document.getElementById('btn-settings').addEventListener('click', (e) => openGlobalSettings(e.currentTarget));
document.getElementById('btn-toolkit').addEventListener('click', () => openOnboarding());
document.getElementById('btn-feedback').addEventListener('click', () => openFeedback());
document.getElementById('btn-span').addEventListener('click', async () => { await window.api.spanDisplays(); updateDisplayReadout(); });

function focusedPane() { return panes.find((p) => p.id === focusedId) || panes[0]; }
function killAll() {
  if (!confirm('Close ALL terminals (active and stored)? This cannot be undone.')) return;
  [...stored].forEach((p) => closeStored(p));
  [...panes].forEach((p) => closePane(p.id));   // the last close shuts the window
}
function toggleAlerts() {
  alertsEnabled = !alertsEnabled;
  if (!alertsEnabled) [...panes, ...stored].forEach(clearAttention);
  flashMsg(alertsEnabled ? 'Alerts ON' : 'Alerts OFF');
}
function flashMsg(text) {
  readoutEl.textContent = text;
  readoutEl.style.color = '#FFD100';
  setTimeout(() => { readoutEl.style.color = ''; relayout(); }, 1300);
}
function saveFocusedOutput() {
  const pane = focusedPane(); if (!pane) return;
  const buf = pane.term.buffer.active; const lines = [];
  for (let i = 0; i < buf.length; i++) { const ln = buf.getLine(i); if (ln) lines.push(ln.translateToString(true)); }
  const text = lines.join('\n').replace(/\s+$/, '') + '\n';
  window.api.saveOutput(pane.nameInput.value || pane.name, text).then((r) => { if (r && r.ok) flashMsg('Saved ✓'); });
}

// Cmd+C from the Edit menu. Inputs/textareas and normal page text keep the
// native behaviour; inside a terminal we copy xterm's real selection, which is
// the whole multi-line block (the native copy only ever saw the current line).
function copyFocusedSelection() {
  const el = document.activeElement;
  const isField = el && (el.tagName === 'INPUT' || (el.tagName === 'TEXTAREA' && !el.classList.contains('xterm-helper-textarea')));
  if (isField && el.selectionStart !== el.selectionEnd) {
    const text = el.value.slice(el.selectionStart, el.selectionEnd);
    navigator.clipboard.writeText(text).catch(() => {});
    pushClip(text);
    return;
  }
  const pane = focusedPane();
  if (pane && pane.term.hasSelection && pane.term.hasSelection()) {
    const sel = pane.term.getSelection();
    navigator.clipboard.writeText(sel).then(() => flashMsg('Copied ✓')).catch(() => {});
    pushClip(sel);
    return;
  }
  // Fall back to any regular page selection (transcript viewer, popovers).
  const sel = String(window.getSelection() || '');
  if (sel.trim()) { navigator.clipboard.writeText(sel).catch(() => {}); pushClip(sel); }
}

function selectAllFocused() {
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || (el.tagName === 'TEXTAREA' && !el.classList.contains('xterm-helper-textarea')))) { el.select(); return; }
  const pane = focusedPane();
  if (pane) pane.term.selectAll();
}

window.api.onMenu((action) => {
  if (action === 'new-terminal') addPane();
  else if (action === 'copy') copyFocusedSelection();
  else if (action === 'select-all') selectAllFocused();
  else if (action === 'recover-sessions') openRecovery();
  else if (action === 'close-terminal' && focusedId) closePane(focusedId);
  else if (action === 'reopen-closed') reopenClosed();
  else if (action === 'kill-all') killAll();
  else if (action === 'clear') { const p = focusedPane(); if (p) { p.term.clear(); p.term.focus(); } }
  else if (action === 'collapse') { const p = focusedPane(); if (p) collapsePane(p); }
  else if (action === 'next') cyclePane(1);
  else if (action === 'prev') cyclePane(-1);
  else if (action === 'toggle-mute') setMute(!soundMuted);
  else if (action === 'toggle-alerts') toggleAlerts();
  else if (action === 'save-output') saveFocusedOutput();
  else if (action === 'open-prefs') openPreferences();
});

window.api.onBroadcast((p) => {
  if (!p) return;
  if (p.type === 'titleSize') applyGlobalTitleSize(p.value, true);
  else if (p.type === 'textSize') applyGlobalTextSize(p.value, true);
  else if (p.type === 'font') applyGlobalFont(p.value, true);
  else if (p.type === 'titleCenter') applyGlobalTitleCenter(p.value, true);
  else if (p.type === 'theme') applyThemeMode(p.value, true);
  else if (p.type === 'mute') setMute(p.value, true);
  else if (p.type === 'settings') { Object.assign(settings, p.value); applySettings(); }
  else if (p.type === 'tileTheme') setTileTheme(p.value, true);
  else if (p.type === 'reskin') reskinAll(p.value);
});

async function updateDisplayReadout() {
  try {
    const list = await window.api.getDisplays();
    const n = list.length;
    displayReadoutEl.innerHTML = lic('monitor') + ` ${n} display${n === 1 ? '' : 's'}`;
    displayReadoutEl.title = list.map((d) => `${d.label}: ${d.width}×${d.height}${d.primary ? ' (primary)' : ''}${d.hasWindow ? ' • open' : ''}`).join('\n');
    renderIcons();
  } catch (_) {}
}
window.api.onDisplays(() => updateDisplayReadout());
window.addEventListener('resize', () => panes.forEach(fitPane));

// Don't let a file dropped outside a terminal navigate the app to that file.
window.addEventListener('dragover', (e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault(); });

// Flush this window's session synchronously on quit so a crash/close loses nothing.
window.addEventListener('beforeunload', () => {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ panes: serializePanes() })); } catch (_) {}
});

// ===========================================================================
// Usage bar — polls a user-configured command (e.g. ccusage) and shows a bar
// ===========================================================================
const usageEl = document.getElementById('usage-readout');
let lastUsageRun = 0;
function renderUsage(out) {
  const text = (out || '').trim();
  const line = text.split('\n').filter((l) => l.trim()).pop() || '';
  const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
  usageEl.querySelector('.usage-label').textContent = 'Usage';
  usageEl.querySelector('.usage-fill').style.width = m ? Math.min(100, parseFloat(m[1])) + '%' : '0%';
  usageEl.querySelector('.usage-text').textContent = line.slice(0, 60);
  usageEl.title = text.slice(0, 500);
}
async function pollUsage(force) {
  if (!settings.usageEnabled || !settings.usageCommand) { usageEl.hidden = true; return; }
  const now = Date.now();
  if (!force && now - lastUsageRun < settings.usageIntervalSec * 1000) return;
  lastUsageRun = now;
  usageEl.hidden = false;
  try { const r = await window.api.runUsage(settings.usageCommand); renderUsage(r && (r.out || r.err)); }
  catch (_) {}
}
setInterval(() => pollUsage(false), 5000);

// ===========================================================================
// First-launch installer wizard
// ===========================================================================
const ONBOARD_KEY = 'tileterm.onboarded.v1';
const INSTALL_TOOLS = [
  // Each tool: a detection probe (check), the suggested install command (cmd), and the
  // official install/docs page (url). The toolkit shows status and lets you run the
  // command in your real terminal or open the guide — it does NOT auto-run installers
  // (those need an interactive shell / sudo / a TTY, which a background process can't give).
  // ── Core ──────────────────────────────────────────────────────────────────
  { id: 'brew',     name: 'Homebrew',           desc: 'Package manager — install everything else',      check: 'command -v brew',       cmd: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', url: 'https://brew.sh' },
  { id: 'clt',      name: 'Xcode CLI Tools',    desc: 'Compilers Homebrew needs',                       check: 'xcode-select -p',       cmd: 'xcode-select --install', url: 'https://mac.install.guide/commandlinetools/' },
  { id: 'git',      name: 'Git',                desc: 'Version control',                                check: 'command -v git',         cmd: 'brew install git', url: 'https://git-scm.com/download/mac' },
  { id: 'node',     name: 'Node.js',            desc: 'JS runtime + npm',                               check: 'command -v node',        cmd: 'brew install node', url: 'https://nodejs.org/en/download' },
  { id: 'fnm',      name: 'fnm',                desc: 'Fast Node version manager',                      check: 'command -v fnm',         cmd: 'brew install fnm', url: 'https://github.com/Schniz/fnm#installation' },
  // ── AI coding agents ─────────────────────────────────────────────────────
  { id: 'claude',   name: 'Claude Code',        desc: "Anthropic's coding agent CLI",                   check: 'command -v claude',      cmd: 'npm install -g @anthropic-ai/claude-code', url: 'https://docs.anthropic.com/en/docs/claude-code/setup' },
  { id: 'codex',    name: 'Codex CLI',          desc: "OpenAI's coding agent CLI",                      check: 'command -v codex',       cmd: 'npm install -g @openai/codex', url: 'https://github.com/openai/codex' },
  { id: 'aider',    name: 'Aider',              desc: 'Open-source AI coding assistant',                check: 'command -v aider',       cmd: 'brew install aider', url: 'https://aider.chat/docs/install.html' },
  { id: 'gemini',   name: 'Gemini CLI',         desc: "Google's Gemini CLI",                            check: 'command -v gemini',      cmd: 'npm install -g @google/gemini-cli', url: 'https://github.com/google-gemini/gemini-cli' },
  { id: 'kiro',     name: 'Kiro CLI',           desc: "Amazon's Kiro agentic IDE CLI",                  check: 'command -v kiro-cli',    cmd: 'brew install --cask kiro-cli', url: 'https://kiro.dev' },
  // ── Package managers ─────────────────────────────────────────────────────
  { id: 'pnpm',     name: 'pnpm',               desc: 'Fast, disk-efficient package manager',           check: 'command -v pnpm',        cmd: 'npm install -g pnpm', url: 'https://pnpm.io/installation' },
  { id: 'bun',      name: 'Bun',                desc: 'Ultra-fast JS runtime & package manager',        check: 'command -v bun',         cmd: 'curl -fsSL https://bun.sh/install | bash', url: 'https://bun.sh/docs/installation' },
  // ── Deploy / cloud ───────────────────────────────────────────────────────
  { id: 'vercel',   name: 'Vercel CLI',         desc: 'Deploy to Vercel from the terminal',             check: 'command -v vercel',      cmd: 'npm install -g vercel', url: 'https://vercel.com/docs/cli' },
  { id: 'supabase', name: 'Supabase CLI',       desc: 'Local Supabase dev + deployments',               check: 'command -v supabase',    cmd: 'brew install supabase/tap/supabase', url: 'https://supabase.com/docs/guides/local-development/cli/getting-started' },
  { id: 'railway',  name: 'Railway CLI',        desc: 'Deploy to Railway from the terminal',            check: 'command -v railway',     cmd: 'npm install -g @railway/cli', url: 'https://docs.railway.com/guides/cli' },
  { id: 'stripe',   name: 'Stripe CLI',         desc: 'Test Stripe webhooks locally',                   check: 'command -v stripe',      cmd: 'brew install stripe/stripe-cli/stripe', url: 'https://docs.stripe.com/stripe-cli' },
  // ── Dev utilities ────────────────────────────────────────────────────────
  { id: 'gh',       name: 'GitHub CLI',         desc: 'gh — GitHub from the terminal',                  check: 'command -v gh',          cmd: 'brew install gh', url: 'https://cli.github.com/' },
  { id: 'rg',       name: 'ripgrep',            desc: 'Lightning-fast code search (rg)',                check: 'command -v rg',          cmd: 'brew install ripgrep', url: 'https://github.com/BurntSushi/ripgrep#installation' },
  { id: 'jq',       name: 'jq',                 desc: 'JSON processor — great for API work',            check: 'command -v jq',          cmd: 'brew install jq', url: 'https://jqlang.github.io/jq/download/' },
  { id: 'python',   name: 'Python 3',           desc: 'Python runtime + pip',                           check: 'command -v python3',     cmd: 'brew install python', url: 'https://www.python.org/downloads/macos/' },
];

function openOnboarding() {
  const ov = document.createElement('div'); ov.id = 'onboard';
  ov.innerHTML = `
    <div class="ob-card">
      <div class="ob-head"><i data-lucide="disc-3"></i> Welcome to DiscoVibe — set up your toolkit</div>
      <div class="ob-sub">Pick your projects folder, then set up the tools you want for vibe-coding. Each row shows whether it's already installed — hit <b>Run</b> to drop the install command into your terminal, or open the official <b>Guide</b>.</div>
      <div class="ob-folder">
        <div class="ob-fold-label"><i data-lucide="folder-open"></i> Where are your projects?</div>
        <div class="ob-fold-row">
          <span class="ob-fold-path"></span>
          <button class="ob-fold-btn pop-custom">Browse…</button>
        </div>
        <div class="ob-fold-note">New terminals open here automatically.</div>
      </div>
      <div class="ob-startnote"><i data-lucide="info"></i> New Mac? Install <b>Xcode Command Line Tools</b> and <b>Homebrew</b> first — Git, Node and most others install through Homebrew (npm tools need Node).</div>
      <div class="ob-list"></div>
      <div class="ob-actions">
        <button class="ob-skip">Close</button>
        <button class="ob-done pop-custom" style="flex:0 0 auto">Done</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  // Project folder picker
  const pathEl = ov.querySelector('.ob-fold-path');
  pathEl.textContent = settings.projectsDir || '~ (home — click Browse to set a folder)';
  ov.querySelector('.ob-fold-btn').addEventListener('click', async () => {
    const r = await window.api.pickFolder();
    if (r && r.ok) { settings.projectsDir = r.path; saveGlobals(); pathEl.textContent = r.path; }
  });

  const finish = () => { localStorage.setItem(ONBOARD_KEY, '1'); ov.remove(); };
  ov.querySelector('.ob-skip').addEventListener('click', finish);
  ov.querySelector('.ob-done').addEventListener('click', finish);

  // Drop a command into the focused terminal (real interactive shell — sudo/TTY work
  // there, unlike a background process), copy it as a fallback, and close so it's visible.
  const runInTerminal = (cmd) => {
    const pane = panes.find((p) => p.id === focusedId) || panes[0];
    if (pane) { window.api.input(pane.id, cmd + '\n'); pane.term.focus(); }
    try { navigator.clipboard.writeText(cmd); } catch (_) {}
    pushClip(cmd);
    finish();
  };

  const list = ov.querySelector('.ob-list');
  INSTALL_TOOLS.forEach((t) => {
    const row = document.createElement('div'); row.className = 'ob-row';
    const status = document.createElement('span'); status.className = 'ob-status'; status.dataset.id = t.id;
    status.textContent = '…'; status.style.color = 'var(--readout)';
    const txt = document.createElement('div'); txt.className = 'ob-txt';
    txt.innerHTML = `<b>${t.name}</b><span>${t.desc}</span>`;
    const actions = document.createElement('div'); actions.className = 'ob-row-actions';
    const run = document.createElement('button'); run.className = 'ob-act'; run.title = `Run in terminal:  ${t.cmd}`;
    run.innerHTML = lic('play') + '<span>Run</span>';
    run.addEventListener('click', () => runInTerminal(t.cmd));
    const guide = document.createElement('button'); guide.className = 'ob-act ob-act-ghost'; guide.title = t.url;
    guide.innerHTML = lic('external-link') + '<span>Guide</span>';
    guide.addEventListener('click', () => { if (t.url) window.api.openExternal(t.url); });
    actions.append(run, guide);
    row.append(status, txt, actions);
    list.appendChild(row);
  });

  // Detect what's already installed (parallel) — purely informational now.
  INSTALL_TOOLS.forEach(async (t) => {
    const statusEl = ov.querySelector(`.ob-status[data-id="${t.id}"]`);
    try {
      const r = await window.api.runUsage(t.check);
      if (r && r.ok) { statusEl.textContent = '✓ installed'; statusEl.style.color = '#7bd88f'; }
      else { statusEl.textContent = 'not installed'; statusEl.style.color = 'var(--readout)'; }
    } catch (_) { statusEl.textContent = ''; }
  });

  renderIcons();
}

// ===========================================================================
// Boot
// ===========================================================================
(function boot() {
  const g = loadGlobals();
  if (g) {
    if (typeof g.globalTitleSize === 'number') globalTitleSize = g.globalTitleSize;
    if (typeof g.globalFontSize === 'number') globalFontSize = g.globalFontSize;
    if (typeof g.globalFontFamily === 'string') globalFontFamily = g.globalFontFamily;
    if (typeof g.globalTitleCenter === 'boolean') globalTitleCenter = g.globalTitleCenter;
    if (g.settings) Object.assign(settings, g.settings);
    soundMuted = !!g.soundMuted;
    if (typeof g.tileTheme === 'string') tileTheme = g.tileTheme;
    if (g.voiceAI) Object.assign(voiceAI, g.voiceAI);
  }
  // Optional baked-in default AI key (renderer/secrets.local.js) for auto-naming.
  const D = window.__DISCOVIBE_DEFAULTS;
  if (D && D.aiKey && !voiceAI.apiKey) {
    voiceAI.apiKey = D.aiKey;
    if (D.aiBaseUrl) voiceAI.baseUrl = D.aiBaseUrl;
    if (D.aiModel) voiceAI.model = D.aiModel;
    saveGlobals();
  }
  setTileTheme(tileTheme, true);
  applyThemeMode(g && g.themeMode ? g.themeMode : 'dark', true);
  refreshMuteBtn();
  applySettings();
  renderIcons();

  const s = loadSession();
  if (s && Array.isArray(s.panes) && s.panes.length) restoreConfigs(s.panes);
  else addPane();
  updateDisplayReadout();
  pollUsage(true);
  fetchRemoteTools();   // refresh tool/command definitions from GitHub in the background

  // First launch on the primary window → offer to install vibe-coding tools.
  if (ROLE === 'primary' && !localStorage.getItem(ONBOARD_KEY)) {
    setTimeout(openOnboarding, 500);
  }
})();

// ===========================================================================
// Aurora / galaxy background — animated color blobs, mouse-responsive
// ===========================================================================
(function initAurora() {
  const canvas = document.getElementById('aurora-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, mx = 0.5, my = 0.5;

  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  window.addEventListener('resize', resize); resize();
  document.addEventListener('mousemove', (e) => {
    // Smooth mouse tracking — lerp toward actual position for fluid drift
    mx += (e.clientX / window.innerWidth  - mx) * 0.04;
    my += (e.clientY / window.innerHeight - my) * 0.04;
  });

  // Each blob: normalized position (0–1), velocity, radius (fraction of max dim), aurora color
  const blobs = [
    { x: 0.15, y: 0.25, vx:  0.00014, vy:  0.00009, r: 0.52, cr: 110, cg: 20,  cb: 255 },  // violet
    { x: 0.72, y: 0.18, vx: -0.00011, vy:  0.00016, r: 0.48, cr: 0,   cg: 190, cb: 255 },  // sky blue
    { x: 0.45, y: 0.82, vx:  0.00016, vy: -0.00013, r: 0.55, cr: 0,   cg: 220, cb: 170 },  // aurora green
    { x: 0.85, y: 0.55, vx: -0.00009, vy: -0.00011, r: 0.42, cr: 70,  cg: 0,   cb: 255 },  // deep indigo
    { x: 0.30, y: 0.65, vx:  0.00010, vy:  0.00014, r: 0.46, cr: 0,   cg: 160, cb: 255 },  // ocean blue
    { x: 0.60, y: 0.40, vx: -0.00013, vy:  0.00008, r: 0.40, cr: 180, cg: 0,   cb: 200 },  // magenta nebula
  ];

  let t = 0;

  function draw() {
    requestAnimationFrame(draw);
    if (document.body.classList.contains('light')) { ctx.clearRect(0, 0, W, H); return; }
    t += 0.0015;
    ctx.clearRect(0, 0, W, H);
    const maxDim = Math.max(W, H);

    blobs.forEach((b, i) => {
      // Drift + very gentle pull toward mouse position
      b.x += b.vx + (mx - 0.5) * 0.000035;
      b.y += b.vy + (my - 0.5) * 0.000035;
      // Soft wrap-around
      if (b.x < -0.4) b.x += 1.8; if (b.x > 1.4) b.x -= 1.8;
      if (b.y < -0.4) b.y += 1.8; if (b.y > 1.4) b.y -= 1.8;

      const px = b.x * W, py = b.y * H;
      const radius = b.r * maxDim;
      // Gently pulse opacity
      const alpha = 0.055 + 0.025 * Math.sin(t * 0.8 + i * 1.1);

      const g = ctx.createRadialGradient(px, py, 0, px, py, radius);
      g.addColorStop(0,   `rgba(${b.cr},${b.cg},${b.cb},${(alpha * 1.6).toFixed(3)})`);
      g.addColorStop(0.4, `rgba(${b.cr},${b.cg},${b.cb},${(alpha * 0.7).toFixed(3)})`);
      g.addColorStop(1,   `rgba(${b.cr},${b.cg},${b.cb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    });
  }

  draw();
})();
