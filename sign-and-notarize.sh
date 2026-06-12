#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# Loads local Apple credentials and produces a SIGNED + NOTARIZED DiscoVibe DMG.
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

echo "▸ Building signed + notarized DMG (this calls Apple's notary service; can take a few minutes)…"
npm run dist

echo
echo "▸ Verifying Gatekeeper acceptance on the built app…"
APP_PATH="dist/mac-arm64/DiscoVibe.app"
if [[ -d "$APP_PATH" ]]; then
  spctl --assess --type execute --verbose "$APP_PATH" || true
  codesign --verify --deep --strict --verbose=2 "$APP_PATH" || true
fi
echo
echo "✓ Done. Distributable DMG is in dist/ (DiscoVibe-<version>-arm64.dmg)."
