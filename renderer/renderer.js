'use strict';

/* global Terminal, FitAddon, WebLinksAddon */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const panes = [];           // ordered list of pane objects
let paneCounter = 0;        // monotonic id/name source
let focusedId = null;
let soundMuted = false;
let themeMode = 'dark';                 // 'dark' | 'light'
const DEFAULT_TITLE_SIZE = 20;          // px
const MIN_TITLE_SIZE = 12;
const MAX_TITLE_SIZE = 56;

const DARK_PALETTE = [
  '#10131a', '#13303f', '#102a22', '#3a1f2b',
  '#2a2150', '#3a2e10', '#10222b', '#301630',
  '#243010', '#102a30', '#2b1840', '#3a1010'
];
const LIGHT_PALETTE = [
  '#f5f7fb', '#e3eefc', '#e6f7f1', '#fcebf0',
  '#efeafc', '#fbf3e0', '#e8f5ec', '#f7e9f7',
  '#eef6df', '#e2f3f7', '#f0e6fb', '#fde7e7'
];
function activePalette() { return themeMode === 'light' ? LIGHT_PALETTE : DARK_PALETTE; }

const gridEl = document.getElementById('grid');
const readoutEl = document.getElementById('layout-readout');
const tpl = document.getElementById('pane-template');

// ---------------------------------------------------------------------------
// Color helpers — adapt text color so it is readable on any background
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = h.length === 3
    ? h.split('').map((c) => c + c).join('')
    : h;
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16)
  };
}

// WCAG relative luminance (0 = black, 1 = white)
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

// Pick a readable foreground (near-black or near-white) for a given background.
function readableFg(hex) {
  return luminance(hex) > 0.45 ? '#11131a' : '#f4f6fb';
}

// A softer dimmed foreground for secondary glyphs.
function dimFg(hex) {
  return luminance(hex) > 0.45 ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.6)';
}

// ---------------------------------------------------------------------------
// Attention bell — chime via Web Audio, flash via CSS
// ---------------------------------------------------------------------------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playChime() {
  if (soundMuted) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  // Two-note "ding-ding" with a gentle bell envelope.
  [880, 1318.5].forEach((freq, i) => {
    const t = now + i * 0.16;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.5);
  });
}

const MAX_CHIMES = 6;       // stop the audio nagging after this many, keep flashing
const CHIME_INTERVAL = 4000;

function triggerAttention(pane) {
  if (!pane.bellOn) return;
  // If this pane is focused and the user is actively looking at it, don't nag.
  pane.el.classList.add('attn');
  if (!pane.attnTimer) {
    pane.chimeCount = 0;
    const fire = () => {
      if (pane.chimeCount < MAX_CHIMES) {
        playChime();
        pane.chimeCount += 1;
      } else {
        clearInterval(pane.attnTimer);
        pane.attnTimer = null;
      }
    };
    fire();
    pane.attnTimer = setInterval(fire, CHIME_INTERVAL);
  }
}

function clearAttention(pane) {
  pane.el.classList.remove('attn');
  if (pane.attnTimer) {
    clearInterval(pane.attnTimer);
    pane.attnTimer = null;
  }
  pane.chimeCount = 0;
}

// ---------------------------------------------------------------------------
// Layout — split N panes into evenly-sized tiles
// ---------------------------------------------------------------------------
// Up to 4 panes => a single row, so each pane is exactly 1/N of the screen
// (full, half, third, quarter). Beyond 4 we fall into balanced rows so panes
// never get unusably thin, and every tile in a row is the same size.
function rowCountsFor(n) {
  if (n <= 0) return [];
  if (n <= 4) return [n];

  let rows;
  if (n <= 6) rows = 2;
  else if (n <= 9) rows = 3;
  else rows = Math.ceil(Math.sqrt(n));

  const base = Math.floor(n / rows);
  const extra = n % rows;
  const counts = [];
  for (let r = 0; r < rows; r++) counts.push(base + (r < extra ? 1 : 0));
  return counts;
}

function relayout() {
  const counts = rowCountsFor(panes.length);

  // Rebuild row containers, re-parenting existing pane elements (keeps terminals alive).
  gridEl.innerHTML = '';
  let idx = 0;
  for (const count of counts) {
    const row = document.createElement('div');
    row.className = 'grid-row';
    for (let i = 0; i < count; i++) {
      row.appendChild(panes[idx].el);
      idx++;
    }
    gridEl.appendChild(row);
  }

  readoutEl.textContent = panes.length === 1 ? '1 pane' : `${panes.length} panes`;

  // Refit terminals once the new geometry is applied.
  requestAnimationFrame(() => {
    for (const pane of panes) fitPane(pane);
  });
}

function fitPane(pane) {
  try {
    pane.fitAddon.fit();
    const { cols, rows } = pane.term;
    if (cols > 0 && rows > 0) window.api.resize(pane.id, cols, rows);
  } catch (_) { /* element not measurable yet */ }
}

// ---------------------------------------------------------------------------
// Pane creation
// ---------------------------------------------------------------------------
function applyColor(pane, color) {
  pane.color = color;
  const fg = readableFg(color);
  const dim = dimFg(color);

  // Header chrome
  pane.headerEl.style.background = color;
  pane.headerEl.style.color = fg;
  pane.el.style.setProperty('--attn', '#ffcc00');

  // Color input + name reflect the choice
  pane.colorInput.value = color;
  pane.nameInput.style.color = fg;

  // Terminal theme — background = chosen color, foreground = readable contrast.
  pane.term.options.theme = {
    ...pane.term.options.theme,
    background: color,
    foreground: fg,
    cursor: fg,
    cursorAccent: color,
    selectionBackground: luminance(color) > 0.45 ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.3)',
    selectionForeground: undefined
  };
  pane.bodyEl.style.background = color;
}

// Set a pane's title font size and grow the header to fit it.
function applyTitleSize(pane, size) {
  const s = Math.max(MIN_TITLE_SIZE, Math.min(MAX_TITLE_SIZE, Math.round(size)));
  pane.titleSize = s;
  pane.nameInput.style.fontSize = s + 'px';
  const headerH = Math.max(34, Math.round(s * 1.6) + 8);
  pane.headerEl.style.height = headerH + 'px';
  pane.headerEl.style.flex = `0 0 ${headerH}px`;
  // Header grew/shrank, so the terminal area changed — refit.
  requestAnimationFrame(() => fitPane(pane));
}

function createPane(opts = {}) {
  paneCounter += 1;
  const id = `p${paneCounter}`;
  const name = opts.name || `Terminal ${paneCounter}`;
  const palette = activePalette();
  const color = opts.color || palette[(paneCounter - 1) % palette.length];

  const node = tpl.content.firstElementChild.cloneNode(true);
  const headerEl = node.querySelector('.pane-header');
  const bodyEl = node.querySelector('.pane-body');
  const nameInput = node.querySelector('.pane-name');
  const colorInput = node.querySelector('.color-input');
  const bellToggle = node.querySelector('.bell-toggle');
  const closeBtn = node.querySelector('.close-btn');
  const smallerBtn = node.querySelector('.title-smaller');
  const biggerBtn = node.querySelector('.title-bigger');

  nameInput.value = name;

  const term = new Terminal({
    fontFamily: 'SFMono-Regular, Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.1,
    fontWeight: 500,
    fontWeightBold: 700,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
    macOptionIsMeta: true,
    theme: { background: color, foreground: readableFg(color) }
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  if (window.WebLinksAddon) term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(bodyEl);

  const pane = {
    id, name, color, term, fitAddon,
    el: node, headerEl, bodyEl, nameInput, colorInput,
    titleSize: opts.titleSize || DEFAULT_TITLE_SIZE,
    bellOn: true, attnTimer: null, chimeCount: 0
  };
  panes.push(pane);
  applyColor(pane, color);
  applyTitleSize(pane, pane.titleSize);

  // ---- Wire the PTY ----
  term.onData((data) => window.api.input(id, data));
  term.onResize(({ cols, rows }) => window.api.resize(id, cols, rows));

  // BEL (\x07) => a tool is asking for attention.
  term.onBell(() => triggerAttention(pane));

  // Focusing / interacting acknowledges the alert.
  const acknowledge = () => { setFocused(id); clearAttention(pane); };
  node.addEventListener('mousedown', acknowledge);
  term.onData(acknowledge);
  term.textarea && term.textarea.addEventListener('focus', acknowledge);

  // ---- Header controls ----
  nameInput.addEventListener('change', () => { pane.name = nameInput.value; });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { nameInput.blur(); term.focus(); }
  });

  colorInput.addEventListener('input', () => {
    applyColor(pane, colorInput.value);
  });
  // Reflect chosen color on the swatch border for quick scanning.
  colorInput.addEventListener('change', () => {
    colorInput.parentElement.style.borderColor = colorInput.value;
  });

  bellToggle.addEventListener('click', () => {
    pane.bellOn = !pane.bellOn;
    bellToggle.classList.toggle('off', !pane.bellOn);
    bellToggle.textContent = pane.bellOn ? '🔔' : '🔕';
    bellToggle.title = pane.bellOn ? 'Bell on for this pane' : 'Bell off for this pane';
    if (!pane.bellOn) clearAttention(pane);
  });

  smallerBtn.addEventListener('click', () => applyTitleSize(pane, pane.titleSize - 2));
  biggerBtn.addEventListener('click', () => applyTitleSize(pane, pane.titleSize + 2));

  closeBtn.addEventListener('click', () => closePane(id));

  // Keep the terminal fitted to its tile as the layout changes.
  const ro = new ResizeObserver(() => fitPane(pane));
  ro.observe(bodyEl);
  pane.resizeObserver = ro;

  // ---- Spawn the shell ----
  fitAddon.fit();
  window.api.spawn({ id, cols: term.cols || 80, rows: term.rows || 24 }).then((res) => {
    if (!res || !res.ok) {
      term.writeln('\x1b[31mFailed to start shell: ' + (res && res.error ? res.error : 'unknown error') + '\x1b[0m');
    }
  });

  return pane;
}

function closePane(id) {
  const i = panes.findIndex((p) => p.id === id);
  if (i === -1) return;
  const pane = panes[i];
  clearAttention(pane);
  if (pane.resizeObserver) pane.resizeObserver.disconnect();
  window.api.kill(id);
  pane.term.dispose();
  panes.splice(i, 1);

  if (panes.length === 0) {
    // Never leave an empty window — open a fresh terminal.
    createPane();
  } else if (focusedId === id) {
    setFocused(panes[Math.max(0, i - 1)].id);
  }
  relayout();
  setTimeout(() => { const f = panes.find((p) => p.id === focusedId); if (f) f.term.focus(); }, 0);
}

function setFocused(id) {
  focusedId = id;
  for (const p of panes) p.el.classList.toggle('focused', p.id === id);
}

// ---------------------------------------------------------------------------
// Add pane (with relayout + focus)
// ---------------------------------------------------------------------------
function addPane() {
  ensureAudio(); // first user gesture unlocks audio
  const pane = createPane();
  relayout();
  setFocused(pane.id);
  setTimeout(() => pane.term.focus(), 30);
  return pane;
}

// ---------------------------------------------------------------------------
// PTY data -> terminal (single dispatcher for all panes)
// ---------------------------------------------------------------------------
window.api.onData(({ id, data }) => {
  const pane = panes.find((p) => p.id === id);
  if (pane) pane.term.write(data);
});

window.api.onExit(({ id }) => {
  const pane = panes.find((p) => p.id === id);
  if (!pane) return;
  pane.term.writeln('\r\n\x1b[90m[process exited — press any key to close]\x1b[0m');
  const off = pane.term.onData(() => { off.dispose(); closePane(id); });
});

// ---------------------------------------------------------------------------
// Toolbar + menu wiring
// ---------------------------------------------------------------------------
document.getElementById('btn-add').addEventListener('click', addPane);

const themeBtn = document.getElementById('btn-theme');
function applyThemeMode(mode) {
  themeMode = mode;
  document.body.classList.toggle('light', mode === 'light');
  themeBtn.textContent = mode === 'light' ? '☀️ Light' : '🌙 Dark';
}
themeBtn.addEventListener('click', () => {
  applyThemeMode(themeMode === 'light' ? 'dark' : 'light');
});

const muteBtn = document.getElementById('btn-mute');
function refreshMuteBtn() {
  muteBtn.textContent = soundMuted ? '🔕 Muted' : '🔔 Bell on';
  muteBtn.classList.toggle('muted', soundMuted);
}
muteBtn.addEventListener('click', () => {
  soundMuted = !soundMuted;
  refreshMuteBtn();
});

window.api.onMenu((action) => {
  if (action === 'new-terminal') addPane();
  else if (action === 'close-terminal' && focusedId) closePane(focusedId);
  else if (action === 'toggle-mute') { soundMuted = !soundMuted; refreshMuteBtn(); }
});

window.addEventListener('resize', () => {
  for (const pane of panes) fitPane(pane);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
addPane();
