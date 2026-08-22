#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# Loads local Apple credentials and produces SIGNED + NOTARIZED DiscoVibe DMG, PKG, and ZIP
# for both Apple Silicon (arm64) and Intel (x64).
# Prereqs (one-time): Developer ID Application cert in keychain + filled-in .env.notarize

if [[ ! -f .env.notarize ]]; then
  echo "✗ .env.notarize not found. Create it with APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID."
  exit 1
fi
# shellcheck disable=SC1091
source .env.notarize

if [[ "${APPLE_ID:-}" == REPLACE_* || "${APPLE_APP_SPECIFIC_PASSWORD:-}" == REPLACE_* ]]; then
  echo "✗ Edit .env.notarize and replace the REPLACE_… placeholders first."
  exit 1
fi

echo "▸ Checking for Developer ID Application certificate…"
if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "✗ No 'Developer ID Application' certificate found in keychain. Create it in Xcode first."
  exit 1
fi

echo "▸ Building signed + notarized installers for Apple Silicon and Intel…"
echo "  (This calls Apple's notary service — can take a few minutes.)"
npm run dist

echo
echo "▸ Verifying Gatekeeper acceptance on built apps…"
for APP_PATH in dist/mac-arm64/DiscoVibe.app dist/mac/DiscoVibe.app; do
  if [[ -d "$APP_PATH" ]]; then
    echo "  Checking $APP_PATH"
    spctl --assess --type execute --verbose "$APP_PATH" || true
    codesign --verify --deep --strict --verbose=2 "$APP_PATH" || true
  fi
done

echo
echo "✓ Done. Distributable files are in dist/:"
ls dist/*.dmg dist/*.pkg 2>/dev/null || true
echo
echo "To publish to GitHub Releases (auto-update + public download):"
echo "  export GH_TOKEN=<token with repo scope>"
echo "  npm run release"
