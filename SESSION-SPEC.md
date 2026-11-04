# Session spec — Consolidate on relaunch (session fcea6c30, 2026-10-29)

Every ask from Monica, checked off only when built AND verified.

## Asks
- [x] On relaunch, DiscoVibe consolidates all open terminal sessions (26 saved panes today: 6 open + 20 collapsed, all in ONE window)
- [x] Review all open panes; detect redundant ones (same repo / same work)
- [x] Separate windows for separate repo work (one window per repo)
- [x] Run closeout on redundant panes
- [x] Organize windows so things don't get unruly again (prevention, not just a one-off cleanup)
- [x] Thought through and built very well; tested before it ships

## Findings that shape the design (verified against real data 10/29)
- Every saved pane has cwd `~/Developer`. Claude cd's inside its own tools, the pane shell never moves.
  So the pane cwd says nothing about the repo. The repo must come from the conversation's .jsonl,
  where every record carries the `cwd` Claude was in. Measured: e005b070 → portal-community-hub,
  04a61e1b → app-launchdialer, 9447e4f7 → ecs-engagement-plan, d7ca72d3 → mostly ~/Developer (General).
- Many sessions span repos (4648c83e: ta-navigator 88, crm 65, tally 18). Use a recency-weighted
  primary repo, and let the triage screen override the destination.
- BUG: WEBSITE, KB and CLOSE Social Posts all hold conversation 89306fd7 (title-matched, not locked).
  resumeAllPanes would `claude --resume` the same conversation in three panes at once. Guard needed.
- `claude --resume <id>` is scoped to the project dir of the cwd, so a restored pane must KEEP its
  original cwd (~/Developer). Only NEW panes in a repo window start at the repo root.
- Windows are keyed per display today (`primary` / display id). Repo windows need their own key
  (`repo-<slug>`), and main's boot must restore them (today it requires a primary to exist).
- Testing must never type `claude --resume` against her real conversations while the live app runs
  them: dry-run switch (DISCOVIBE_DRY_RUN=1) that shows commands instead of typing them.

## Design
1. **Analyze** (main, `session-repos.js`): per conversation id → exists, title, last prompt, mtime,
   primary repo (cwd counts from the file head + 2× weight on the tail), share, other repos.
   Per repo → branch + uncommitted count. Cached on size+mtime.
2. **Plan** (renderer, `consolidate.js`, pure + node-testable): collect saved panes from EVERY window
   key; group by destination (repo name, or General); flag duplicates (same conversation), missing
   conversations, plain shells, completed, similar titles in one repo. Default actions are conservative:
   Keep, except exact duplicate → Close (keeps the best-bound pane), empty collapsed shell → Close,
   missing/completed conversation → Close.
3. **Triage screen** on launch, before anything restores, when: a duplicate exists, a window mixes
   groups, or a group spans windows. Per row: Keep / Close out / Close, and destination override.
   "Restore as before" skips (remembered per layout signature so it does not nag). Menu item
   "Consolidate Windows…" opens it any time; applying mid-session restarts DiscoVibe (confirmed first).
4. **Apply**: write each group's panes to `tileterm.session.v1:repo-<slug>` + window meta
   (repoRoot, name); primary hosts General (or the largest group if General is empty); main opens one
   window per group. Other windows wait on a boot gate so nothing restores twice.
5. **Close-outs**: panes marked Close out go to one temporary "Close-outs" window. They resume, then
   run the close-out command ONE AT A TIME (it asks questions; parallel commits in one clone collide).
   Bar per pane: Finished → mark conversation complete + close pane → next. Skip. The command is a
   setting; default `/closeout` only when ~/.claude/commands/closeout.md or a closeout skill exists.
6. **Prevention**: resume never runs one conversation in two panes; ⌘T in a repo window opens at the
   repo root; triage re-checks on every launch and only appears when something is off.

## Decisions taken without asking (reversible)
- "Close" = not restored. The conversation stays in ~/.claude and in the Work Tracker; nothing deleted.
- Kept panes are restored expanded (one repo per window makes collapsing unnecessary).
- Repo windows open on the primary display, maximized, titled with the repo name.

## Status (end of session fcea6c30)
- Built, committed + pushed: 423b89a (v1.10.0). Dry-run tested on copies of the real 26-pane layout:
  triage, apply (11 windows), close-out to Finished, relaunch (no re-prompt), Restore as before,
  Cmd+Shift+G restart path, restore without a saved primary, packaged build.
- [ ] Install over /Applications/DiscoVibe.app (needs DiscoVibe quit; Monica picks the moment)
- [ ] GitHub release for other users: not done, waiting on Monica (questions board)
- Dev gotcha: node-pty prebuilds/darwin-*/spawn-helper lacked +x (posix_spawnp failed); chmod'd locally.

## Asks (2026-11-02)
- [x] Mark a session "closed" for real so it stops showing in the restore lists (009e869)
- [x] Popup box too small (10ff597)
- [x] Sidebar of incomplete sessions that lives in the window, toggled on/off
- [x] "Waiting on you" queue: jump to the next pane waiting for input, Dock badge count
- [ ] GitHub public release v1.10.0 (blocked: Apple app-specific password needs regenerating)

## Asks (2026-11-03)
- [x] Sessions sidebar on the left (9e9b444)
- [x] Search at the top of the sidebar, filters every section
- [x] Let the person pick left or right; obvious hide (labelled Hide) and show (yellow Sessions tab)
- [x] Quit, install the new build into /Applications
- [x] Website page refreshed (icon, features, past paid-app date removed; 92a198a, verified live)
- [x] Released v1.10.0 (notarized), website shows v1.10.0 + Latest badge, verified
- [x] Draft email to James Coats about 1.10 (monica@ draft r2687027417392857061, AI-Draft label; send after the release is live)
- [x] What's new section on the website page (b4a8d7e, live; 1.10.0 shows "Coming next" until released)
- [x] Ask for an email when someone downloads (optional prompt; DiscoVibe Updates list via program-waitlist-signup, crm 08551e0b; website live, verified 11/3)
- [x] Resend draft to DiscoVibe Updates list (broadcast 684603ea-4e64-42ec-a3f9-ae9b060ffc47, draft, not sent)
