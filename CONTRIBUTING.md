# Contributing to Lumen

Lumen is a local-first Kubernetes desktop workbench. Contributions should preserve the core project constraints: open source, secure by design, direct kubeconfig access, no hosted backend requirement, and responsive behavior on large clusters.

## Development Setup

Requirements:

- Node.js 24 or newer.
- Rust stable.
- A Kubernetes cluster for manual testing, such as kind, k3d, minikube, or a non-production remote cluster.

Install dependencies:

```bash
npm install
```

Run the web dev server:

```bash
npm run dev
```

Run the desktop app:

```bash
npm run tauri dev
```

Create a representative local kind cluster:

```bash
./scripts/kind-fixture.sh
```

This applies the fixture in `testdata/k8s/lumen-fixtures.yaml` and creates resources that exercise workloads, services, ingress, network policy, RBAC, secrets, storage, quotas, limits, PDBs, and HPAs.

## Checks

Run these before opening a pull request:

```bash
npm run lint
npm run test
npm run build
npm run perf:bundle
cargo test --manifest-path src-tauri/Cargo.toml
```

If you change Rust formatting or lint-sensitive code, also run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

## Contribution Guidelines

- Keep changes focused. Avoid unrelated refactors in feature or bug-fix pull requests.
- Add tests for new behavior and regressions.
- Do not commit kubeconfig files, tokens, cluster secrets, screenshots with sensitive data, or generated local planning artifacts.
- For mutating Kubernetes actions, include RBAC preflight behavior, clear confirmation UX, and server-side dry-run where the API supports it.
- For lists, logs, events, and graph-heavy UI, consider large-cluster performance from the start.
- Keep user-facing copy neutral and useful. Avoid exposing implementation details unless they help resolve the issue.

## Pull Request Checklist

- Tests and checks pass locally.
- New behavior is covered by unit, component, Rust, or E2E tests as appropriate.
- Security-sensitive flows avoid logging tokens, secret values, or raw credentials.
- UI changes handle loading, empty, error, and partial-permission states.
- Documentation is updated when behavior, setup, or release process changes.
