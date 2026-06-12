# Signing & notarizing DiscoVibe (zero-friction installs)

The build pipeline is already configured (hardened runtime, entitlements,
`notarize.teamId` = `2YX9U57HFL`). It needs two things only your Apple account can
produce. Do these once, then every `npm run dist` produces a signed + notarized DMG
that opens with no "damaged"/"unidentified developer" warnings on any Mac.

## 1. Install a "Developer ID Application" certificate (one time)
Easiest path (Xcode):
1. Open **Xcode → Settings → Accounts**, sign in with the Apple ID on the Developer
   Program (Team `2YX9U57HFL`).
2. Select the team → **Manage Certificates… → + → Developer ID Application**.
3. It installs into your login keychain. Verify:
   ```
   security find-identity -v -p codesigning   # should list: Developer ID Application: … (2YX9U57HFL)
   ```
(Alternative without Xcode: developer.apple.com → Certificates → +
→ "Developer ID Application", upload a CSR from Keychain Access, download the .cer,
double-click to install. Keep the private key in the same keychain.)

## 2. Create an app-specific password for notarization (one time)
1. Go to **appleid.apple.com → Sign-In & Security → App-Specific Passwords → +**.
2. Name it "DiscoVibe notarize", copy the generated password (format `abcd-efgh-ijkl-mnop`).

## 3. Build signed + notarized
```
cd ~/Developer/discovibe
export APPLE_ID="your-apple-id@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="2YX9U57HFL"
npm run dist            # signs with Developer ID + notarizes via notarytool, then staples
```
(Do NOT set `CSC_IDENTITY_AUTO_DISCOVERY=false` — that's the unsigned/ad-hoc path.)

Then publish + point the website at it:
```
gh release create v<NEW> dist/DiscoVibe-<v>-arm64.dmg --repo Launch-Industries/DiscoVibe --title "…" --notes "…"
# update DMG_URL + VERSION in website-launchindustries.biz/src/pages/DiscoVibe.jsx → git push → vercel --prod --yes
```

## Notes
- The membership fee is Apple's ($99/yr); the Team ID `2YX9U57HFL` is already wired in.
- Until the cert is installed, builds fall back to ad-hoc signing (current v1.4.0):
  runs after a right-click → Open, but shows the unsigned warning.
- Keychain may prompt to allow `codesign` to use the key during the first signed build —
  click "Always Allow".
