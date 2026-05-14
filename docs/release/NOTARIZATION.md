# macOS Signing And Notarization

Lumen's release workflow already has a signed macOS path. It is activated when
the required Apple secrets are present in the GitHub repository.

## Required Apple Account Setup

You need:

- An active Apple Developer Program membership.
- A Developer ID Application certificate.
- An app-specific password for the Apple ID, or App Store Connect API key
  credentials if you adapt the workflow to API-key notarization.
- The Apple Team ID.

## Create A Developer ID Certificate

1. Open Keychain Access on macOS.
2. Create a certificate signing request.
3. In Apple Developer, create a `Developer ID Application` certificate.
4. Download the certificate and import it into Keychain.
5. Export the certificate and private key as a password-protected `.p12` file.

Convert it to base64 for GitHub Secrets:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
```

## GitHub Secrets

Add these repository secrets under GitHub repo Settings, Secrets and variables,
Actions:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` |
| `KEYCHAIN_PASSWORD` | Temporary CI keychain password |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application identity name |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_PASSWORD` | Apple app-specific password |
| `APPLE_TEAM_ID` | Apple Team ID |

The current workflow detects these values in
`.github/workflows/release.yml`. When present, it runs the signed Tauri build
path and passes the notarization environment variables to Tauri.

## Find The Signing Identity

On the Mac where the certificate is installed:

```bash
security find-identity -v -p codesigning
```

Use the full `Developer ID Application: ... (TEAMID)` identity for
`APPLE_SIGNING_IDENTITY`.

## Verify A Release Artifact

After the release workflow completes, download the DMG and verify:

```bash
spctl -a -vv --type open Lumen_<version>_aarch64.dmg
hdiutil attach Lumen_<version>_aarch64.dmg
spctl -a -vv /Volumes/Lumen/Lumen.app
codesign --verify --deep --strict --verbose=2 /Volumes/Lumen/Lumen.app
```

Expected results:

- `spctl` accepts the DMG or app.
- `codesign` verification succeeds.
- The release logs no longer contain "skipping app notarization".

## Common Failures

- `No identity found`: `APPLE_SIGNING_IDENTITY` does not match the certificate
  imported into the CI keychain.
- `notarization authentication failed`: check `APPLE_ID`, `APPLE_PASSWORD`,
  and `APPLE_TEAM_ID`.
- Gatekeeper still warns: the build may be signed but not notarized. Confirm the
  release logs and run the `spctl` checks above.

