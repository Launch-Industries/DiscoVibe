# Distributing DiscoVibe to users you don't know

This is the playbook for shipping DiscoVibe to the public and keeping every
installed copy current. Three independent systems work together:

| System | What it does | Needs a new app build? |
|---|---|---|
| **Code signing** (`SIGNING.md`) | App opens with no scary macOS warning | — |
| **Auto-update** (this doc) | Users get new app versions automatically | Yes — that's the point |
| **Remote tools** (`tools.json`) | Fix a wrong CLI command for everyone instantly | **No** |

---

## 1. Remote tool commands — fix commands without a new release

`tools.json` (in the repo root) holds every install/launch command. The app
fetches it from GitHub on launch and patches its built-in list. **This is the
fastest way to fix a wrong command for all users.**

### To push a command fix to everyone:
1. Edit the command in `tools.json`.
2. **Bump the `version` number** (e.g. `1` → `2`). The app only applies changes
   when the remote version is higher than its cached version.
3. Commit + push to the `main` branch.

```bash
# example: fix the kiro launch command
# edit tools.json → change command, set "version": 2
git add tools.json && git commit -m "Fix kiro launch command" && git push
```

Within seconds of their next app launch, every user has the corrected command.
No download, no reinstall.

> The app reads `tools.json` from:
> `https://raw.githubusercontent.com/launchindustries/discovibe/main/tools.json`
> If the repo owner/name differs, update `REMOTE_TOOLS_URL` in `renderer/renderer.js`.

### Self-checking commands (avoid shipping wrong ones)
Before adding/changing any CLI command, verify it against the official source:
- npm packages → check the package exists on npmjs.com
- brew formulae → `brew info <name>` or formulae.brew.sh
- launch binaries → the tool's official docs/install page

---

## 2. Auto-update — ship new app versions

The app uses `electron-updater`, checking GitHub Releases 5 seconds after launch
(packaged builds only). When a newer version exists it prompts the user to
download, then to restart. Configured in `main.js` + the `build.publish` block in
`package.json`.

### To release a new version:
```bash
cd ~/Developer/discovibe

# 1. Bump the version in package.json (e.g. 1.5.0 → 1.5.1)

# 2. Sign + notarize + publish to GitHub Releases in one step:
export APPLE_ID="your-apple-id@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="2YX9U57HFL"
export GH_TOKEN="<github personal access token with repo scope>"
npm run release        # builds, signs, notarizes, uploads DMG+zip+latest-mac.yml to a GitHub Release
```

`npm run release` runs `electron-builder --mac --publish=always`. It uploads:
- `DiscoVibe-<version>-arm64.dmg` (the installer users download the first time)
- `DiscoVibe-<version>-arm64-mac.zip` (what auto-update downloads)
- `latest-mac.yml` (the manifest auto-update reads to detect new versions)

> **The `latest-mac.yml` file is critical** — without it, auto-update can't detect
> new versions. `electron-builder` generates and uploads it automatically with
> `--publish=always`. Don't delete it from the release.

### GH_TOKEN
Create at github.com → Settings → Developer settings → Personal access tokens →
Tokens (classic) → Generate, with `repo` scope. Export it before `npm run release`.

---

## 3. First-time install (new users)

Point users at the latest GitHub Release's `.dmg`, or a download page on
launchindustries.biz that links to it. Because the build is signed + notarized
(see `SIGNING.md`), it opens with a normal "DiscoVibe wants to..." dialog — no
right-click-to-open dance.

### Optional: Homebrew cask (zero-friction installs)
Once you have signed releases, you can submit a cask so users run:
```bash
brew install --cask discovibe
```
This is the lowest-friction path for a developer audience. Submit to
homebrew-cask after a few stable signed releases.

---

## Release checklist

- [ ] Code-signing cert installed (`security find-identity -v -p codesigning`)
- [ ] `package.json` version bumped
- [ ] `tools.json` version bumped (only if commands changed)
- [ ] `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `GH_TOKEN` exported
- [ ] `npm run release` succeeds, GitHub Release created with `.dmg`, `.zip`, `latest-mac.yml`
- [ ] Download a fresh copy and confirm it opens without a warning
- [ ] Confirm an older installed copy gets the update prompt
