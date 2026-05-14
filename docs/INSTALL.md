# Install Lumen

Download the latest release from the
[GitHub releases page](https://github.com/i-am-uranium/lumen/releases/latest).

## macOS

Choose the build that matches your Mac:

- Apple Silicon: `Lumen_<version>_aarch64.dmg`
- Intel: `Lumen_<version>_x64.dmg`

Open the DMG and drag Lumen into Applications.

Current public builds may be unsigned or ad-hoc signed until Apple Developer
notarization is configured. If macOS blocks the app, right-click Lumen and
choose Open. Treat this as a preview-channel install path.

## Windows

Choose one of:

- `Lumen_<version>_x64-setup.exe` for the standard installer.
- `Lumen_<version>_x64_en-US.msi` for managed deployments.

Current public builds may be unsigned until Windows code signing is configured.
Windows SmartScreen can warn on first launch.

## Linux

Choose one of:

- `Lumen_<version>_amd64.AppImage` for a portable build.
- `Lumen_<version>_amd64.deb` for Debian or Ubuntu.
- `Lumen-<version>-1.x86_64.rpm` for Fedora, RHEL, or compatible systems.

For AppImage:

```bash
chmod +x Lumen_<version>_amd64.AppImage
./Lumen_<version>_amd64.AppImage
```

## Verify Downloads

GitHub release assets include SHA-256 digests in the release asset metadata.
You can also compute the digest locally:

```bash
shasum -a 256 Lumen_<version>_aarch64.dmg
```

Compare the output with the digest shown for the release asset.

## First Run

Lumen uses your existing kubeconfig. Before launching, make sure this works:

```bash
kubectl config get-contexts
kubectl get namespaces
```

Lumen follows your Kubernetes RBAC permissions. If a user can only read a
namespace, mutating controls should be unavailable or fail during preflight.

