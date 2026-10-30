'use strict';

// ===========================================================================
// Consolidation planning: one window per repo.
// ===========================================================================
// Pure functions only, so the plan can be checked in Node against a real saved
// layout before anything opens a window. The triage screen that edits a plan
// and the boot pass that applies one live in renderer.js.
//
// Vocabulary
//   item   one saved pane, from any window
//   group  where an item belongs: a repo root, or '' for General (no repo)
//   action keep | closeout | close
//            keep      restored in its group's window
//            closeout  restored in the temporary Close-outs window, where the
//                      close-out command runs on it, one pane at a time
//            close     not restored; the conversation stays in ~/.claude
(function (root) {
  const DAY = 24 * 60 * 60 * 1000;
  const IDLE_DAYS = 3;
  const MAX_PER_WINDOW = 30;            // renderer.js MAX_TERMINALS
  const GENERAL = '';
  const CLOSEOUTS_KEY = 'closeouts';

  function bareTitle(s) {
    return String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  }
  function titleIsGeneric(t) {
    const s = bareTitle(t).toLowerCase();
    return !s || s === 'claude code' || /^claude code\b/.test(s);
  }
  function isDefaultName(n) { return !n || /^Terminal \d+$/i.test(String(n).trim()); }
  function words(t) {
    return new Set(bareTitle(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
  }
  // Same work under two names reads as a large overlap in title words. Short
  // titles are left alone: two shared words out of two proves nothing.
  function similarTitles(a, b) {
    const A = words(a), B = words(b);
    if (A.size < 2 || B.size < 2) return false;
    let shared = 0;
    for (const w of A) if (B.has(w)) shared += 1;
    return shared / (A.size + B.size - shared) >= 0.5;
  }
  function slug(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'repo';
  }
  function basename(p) { return String(p || '').replace(/\/+$/, '').split('/').pop() || ''; }
  function ago(ms, now) {
    const d = Math.max(0, now - ms);
    if (d < 60 * 60 * 1000) return Math.max(1, Math.round(d / 60000)) + 'm ago';
    if (d < DAY) return Math.round(d / 3600000) + 'h ago';
    return Math.round(d / DAY) + 'd ago';
  }

  // windows: [{ key, meta: { repoRoot } | null, panes: [cfg] }]
  // analysis: the result of the main process's consolidate-analyze
  function buildPlan({ windows, analysis, now }) {
    now = now || Date.now();
    const A = analysis || {};
    const sessions = A.sessions || {};
    const cwdRepos = A.cwdRepos || {};
    const repos = A.repos || {};
    const items = [];

    for (const win of windows || []) {
      const winRepo = (win.meta && win.meta.repoRoot) || GENERAL;
      (win.panes || []).forEach((cfg, index) => {
        const sessionId = cfg.aiSessionId || '';
        const s = sessionId ? sessions[sessionId] : null;
        const item = {
          uid: win.key + '#' + index,
          sourceKey: win.key,
          sourceGroup: winRepo,
          cfg,
          name: cfg.name || '',
          sessionId,
          session: s && s.exists ? s : null,
          title: bareTitle((s && s.title) || cfg.aiName || ''),
          lastPrompt: (s && s.lastPrompt) || '',
          mtime: (s && s.mtime) || 0,
          others: (s && s.others) || [],
          flags: [],
          action: 'keep',
          dest: GENERAL,
        };
        // Where it belongs: the conversation's own record first, then the
        // shell's folder, then the window the user put it in.
        if (item.session && item.session.repoRoot) item.dest = item.session.repoRoot;
        else if (cwdRepos[cfg.cwd]) item.dest = cwdRepos[cfg.cwd];
        else item.dest = winRepo;
        items.push(item);
      });
    }

    // ---- Problems that decide the default action --------------------------
    const bySession = new Map();
    for (const it of items) {
      if (!it.sessionId) continue;
      if (!bySession.has(it.sessionId)) bySession.set(it.sessionId, []);
      bySession.get(it.sessionId).push(it);
    }
    // Only one pane can resume a conversation. Keep the one whose binding is
    // strongest: proved by its own output, then open over collapsed, then a
    // name you gave it over a default one.
    const rank = (it) => (it.cfg.aiLocked ? 8 : 0) + (it.cfg.collapsed ? 0 : 4) + (isDefaultName(it.name) ? 0 : 2) + (it.cfg.aiTitled ? 1 : 0);
    for (const group of bySession.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => rank(b) - rank(a));
      const keeper = sorted[0];
      for (const it of sorted.slice(1)) {
        it.action = 'close';
        it.dupOf = keeper.uid;
        it.flags.push({ kind: 'dup', text: 'Same conversation as “' + (keeper.name || keeper.title) + '”. Only one pane can resume it.' });
      }
    }

    for (const it of items) {
      if (it.dupOf) continue;
      if (it.sessionId && !it.session) {
        it.action = 'close';
        it.flags.push({ kind: 'missing', text: 'Its conversation file is gone, so there is nothing to resume.' });
      } else if (it.session && it.session.completed) {
        it.action = 'close';
        it.flags.push({ kind: 'done', text: 'Marked done in the Work Tracker.' });
      } else if (!it.sessionId) {
        it.flags.push({ kind: 'shell', text: 'Plain shell, no conversation.' });
        if (it.cfg.collapsed) it.action = 'close';
      }
    }

    // ---- Things worth knowing, which do not change the default -------------
    for (const it of items) {
      if (it.session && titleIsGeneric(it.title)) it.flags.push({ kind: 'untitled', text: 'Conversation has no title yet.' });
      if (it.mtime && now - it.mtime > IDLE_DAYS * DAY) it.flags.push({ kind: 'idle', text: 'Idle ' + ago(it.mtime, now).replace(' ago', '') + '.' });
      if (it.others.length) it.flags.push({ kind: 'mixed', text: 'Also worked in ' + it.others.join(', ') + '.' });
    }
    const live = items.filter((it) => !it.dupOf && it.session);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        if (a.dest !== b.dest || !similarTitles(a.title, b.title)) continue;
        a.flags.push({ kind: 'similar', text: 'Looks like the same work as “' + (b.name || b.title) + '”.' });
        b.flags.push({ kind: 'similar', text: 'Looks like the same work as “' + (a.name || a.title) + '”.' });
      }
    }

    const groupInfo = (dest) => dest === GENERAL
      ? { id: GENERAL, name: 'General', repoRoot: '', branch: '', dirty: null }
      : { id: dest, name: (repos[dest] && repos[dest].name) || basename(dest), repoRoot: dest,
          branch: (repos[dest] && repos[dest].branch) || '', dirty: repos[dest] ? repos[dest].dirty : null };

    const plan = { items, groupInfo, now };
    plan.needed = isNeeded(plan);
    return plan;
  }

  // Every group that will hold an item, in a stable order: biggest first,
  // General last (it is the catch-all, not a project).
  function groupsOf(plan) {
    const ids = new Map();
    for (const it of plan.items) ids.set(it.dest, (ids.get(it.dest) || 0) + 1);
    return [...ids.keys()]
      .map((id) => ({ ...plan.groupInfo(id), count: ids.get(id) }))
      .sort((a, b) => (a.id === GENERAL) - (b.id === GENERAL) || b.count - a.count || a.name.localeCompare(b.name));
  }

  // The windows a plan produces. The primary window hosts General, or the
  // largest group when nothing is General, so there is never an empty window
  // left behind just to be the primary.
  function layout(plan) {
    const keepByGroup = new Map();
    const closeouts = [];
    const closed = [];
    for (const it of plan.items) {
      if (it.action === 'close') { closed.push(it); continue; }
      const cfg = { ...it.cfg, collapsed: false };
      delete cfg.closeoutPending; delete cfg.closeoutRepo;
      if (it.action === 'closeout') {
        closeouts.push({ ...cfg, closeoutPending: true, closeoutRepo: plan.groupInfo(it.dest).name });
        continue;
      }
      if (!keepByGroup.has(it.dest)) keepByGroup.set(it.dest, []);
      keepByGroup.get(it.dest).push(cfg);
    }

    const groups = [...keepByGroup.keys()]
      .map((id) => ({ ...plan.groupInfo(id), panes: keepByGroup.get(id) }))
      .sort((a, b) => (a.id === GENERAL) - (b.id === GENERAL) || b.panes.length - a.panes.length || a.name.localeCompare(b.name));
    const primaryGroup = groups.find((g) => g.id === GENERAL) || groups[0] || null;

    const out = [];
    const usedKeys = new Set(['primary', CLOSEOUTS_KEY]);
    for (const g of groups) {
      for (let part = 0; part * MAX_PER_WINDOW < g.panes.length; part++) {
        const panes = g.panes.slice(part * MAX_PER_WINDOW, (part + 1) * MAX_PER_WINDOW);
        const title = g.name + (part ? ' (' + (part + 1) + ')' : '');
        let key;
        if (g === primaryGroup && part === 0) key = 'primary';
        else {
          key = 'repo-' + slug(title);
          for (let n = 2; usedKeys.has(key); n++) key = 'repo-' + slug(title) + '-' + n;
        }
        usedKeys.add(key);
        out.push({ key, title, repoRoot: g.repoRoot, panes });
      }
    }
    if (closeouts.length) out.push({ key: CLOSEOUTS_KEY, title: 'Close-outs', repoRoot: '', panes: closeouts.slice(0, MAX_PER_WINDOW) });
    // A plan that keeps nothing still needs the primary window to open into.
    if (!out.some((w) => w.key === 'primary')) out.unshift({ key: 'primary', title: 'General', repoRoot: '', panes: [] });
    return { windows: out, closed };
  }

  // Worth showing the triage screen? Only when applying the defaults would
  // change something: a pane in the wrong window, or a default that closes or
  // closes out a pane. A tidy layout restores silently.
  function isNeeded(plan) {
    if (plan.items.some((it) => it.action !== 'keep')) return true;
    const target = new Map();
    for (const w of layout(plan).windows) for (const cfg of w.panes) target.set(cfg, w.key);
    return plan.items.some((it) => {
      for (const [cfg, key] of target) if (sameCfg(cfg, it.cfg)) return key !== it.sourceKey;
      return false;
    });
  }
  function sameCfg(a, b) {
    return a.name === b.name && a.aiSessionId === b.aiSessionId && a.cwd === b.cwd && a.color === b.color;
  }

  // A layout the user already chose to restore as-is should not be offered
  // again on every launch; any change to it brings the screen back.
  function signature(plan) {
    const s = plan.items.map((it) => [it.sourceKey, it.sessionId || it.name, it.dest, it.action].join('|')).sort().join('\n');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + plan.items.length;
  }

  const api = { buildPlan, groupsOf, layout, signature, similarTitles, bareTitle, ago, GENERAL, CLOSEOUTS_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Consolidate = api;
})(typeof window !== 'undefined' ? window : globalThis);
