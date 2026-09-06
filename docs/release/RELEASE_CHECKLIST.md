# Release Checklist

Use this checklist before publishing a public Lumen release.

## Before The Release PR

- Confirm `main` is green in GitHub Actions.
- Confirm branch protection requires pull requests and passing checks.
- Run local verification:

```bash
npm run lint
npm run test
node --test scripts/verify-release-assets.test.mjs
npm run build
npm run perf:bundle
npm audit --audit-level=high
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
./scripts/test-kind.sh
```

- Run dependency and secret scans in CI.
- Update user-facing docs when features, installation, or security behavior
  change.
- Prepare release notes with highlights, fixes, known issues, and upgrade notes.

## Version Bump

Use the version bump helper:

```bash
npm run bump -- 0.15.0
```

Review all changed manifests:

```bash
git diff package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
```

Open a release PR and wait for CI.

## Release Workflow

Merging a version bump to `main` lets `.github/workflows/release.yml` create the
matching `v<version>` tag and build draft release assets. Before creating the
tag, the workflow runs the full CI suite against the exact release commit.
Existing drafts can be retried by dispatching the release workflow with their
tag; the original tag commit is verified and rebuilt. Published releases are
never overwritten by this workflow.

The workflow currently builds:

- macOS DMGs and updater archives for Apple Silicon and Intel.
- Linux AppImage, DEB, and RPM assets.
- Windows NSIS and MSI installers.
- Tauri updater signatures and `latest.json`.

The final job validates required artifacts, nonempty uploads, updater version,
platform coverage, signatures being present, and download references. This is a
manifest check, not proof of OS signing or a successful updater installation.
The release stays a draft for review.

Before publishing, install the draft on each advertised platform and test an
upgrade from the last public version, including signature verification and
relaunch. Confirm the draft is still tied to the successful release run's SHA.
Review the notes and signing caveats, then explicitly publish the draft through
GitHub Releases. Do not publish if any required CI, build, or manifest check
failed. Mark unsigned builds as preview builds.

## Signing Expectations

- macOS public releases should be Developer ID signed and notarized.
- Windows public releases should be Authenticode signed before being marketed
  outside a preview audience.
- Linux releases should include clear SHA-256 verification guidance.

See `docs/release/NOTARIZATION.md` for macOS setup.

## Publish Notes

Release notes should include:

- One-paragraph summary.
- Feature highlights.
- Bug fixes.
- Security-relevant changes.
- Known issues.
- Install links and platform caveats.
- Verification instructions.

Example structure:

```markdown
## Highlights

- ...

## Fixes

- ...

## Known Issues

- ...

## Downloads

- macOS Apple Silicon: ...
- macOS Intel: ...
- Windows: ...
- Linux: ...
```
