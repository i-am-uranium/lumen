# Lumen

Lumen is an open source desktop workbench for Kubernetes clusters. It gives operators and developers a fast local UI for cluster discovery, workload triage, logs, events, YAML inspection, port forwarding, Helm release operations, and pod shell sessions.

Lumen exists for teams and individuals who want a capable Kubernetes dashboard without sending cluster access through a hosted SaaS control plane.

## Scope

Lumen is intentionally local-first:

- Reads cluster access from the user's kubeconfig.
- Talks directly to Kubernetes APIs from the Tauri app.
- Does not require a hosted backend, gateway, or SaaS account.
- Keeps cluster state and UI preferences on the user's machine.

## Features

- Multi-context fleet view with health probes and soft-disconnect.
- Namespace-aware workload explorer for core Kubernetes resources and long-tail resource families.
- Resource detail drawer with events, YAML, labels, owner references, pod metrics, container state, and kind-specific insights.
- Rich detail views for RBAC, storage, services, ingress, NetworkPolicy, HPA, PDB, ResourceQuota, and LimitRange resources.
- Logs with virtualized rendering, search, pause/resume, bounded buffers, and multi-workload streams.
- Pod shell sessions via Kubernetes attach, with lazy-loaded terminal code.
- Port forwarding for Pods and Services.
- Helm release list, details, history, install, upgrade, rollback, and uninstall flows.
- CRD discovery and custom resource YAML inspection.
- DevSec scan for workload security context, mutable images, missing probes/limits, NetworkPolicy coverage, risky services, and RBAC risks.
- RBAC-aware mutating actions for YAML apply and generic resource delete.
- Secret YAML redaction by default.

See [docs/FEATURES.md](docs/FEATURES.md) for a fuller feature overview.

## Screenshot

A masked workload explorer screenshot is included in the
[feature overview](docs/FEATURES.md#screenshot).

## Install

Download the latest release from
[GitHub Releases](https://github.com/i-am-uranium/lumen/releases/latest).

Lumen ships macOS, Windows, and Linux preview builds. See
[docs/INSTALL.md](docs/INSTALL.md) for platform-specific install and download
verification steps.

## Security Model

- No hosted backend: the app talks to the Kubernetes API directly from the local desktop process.
- Uses the user's kubeconfig and current Kubernetes RBAC permissions.
- Write operations are narrow, explicit, and guarded with RBAC checks where supported.
- Secret resource YAML redacts `data`, `stringData`, and `binaryData` before rendering.
- See [docs/security/SECURITY_MODEL.md](docs/security/SECURITY_MODEL.md) and [SECURITY.md](SECURITY.md).

## Tech Stack

- React 19, TypeScript, Vite, Tailwind CSS.
- Tauri 2 with Rust command handlers.
- kube-rs for Kubernetes API access and watches.
- TanStack Query for frontend data fetching and cache invalidation.
- TanStack Virtual for high-volume log and table rendering.
- xterm.js for pod attach sessions.
- Vitest and Rust tests for core behavior.

## Development

```bash
npm install
npm run dev
```

Run the desktop shell:

```bash
npm run tauri dev
```

Create a local kind fixture cluster:

```bash
./scripts/kind-fixture.sh
```

Then select context `kind-lumen-dev` and namespace `lumen-demo`. See [docs/development/local-cluster.md](docs/development/local-cluster.md).

Run checks:

```bash
npm run lint
npm run test
npm run build
npm run perf:bundle
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [SECURITY.md](SECURITY.md) for vulnerability reporting.

Release maintainers should use
[docs/release/RELEASE_CHECKLIST.md](docs/release/RELEASE_CHECKLIST.md) and
[docs/release/NOTARIZATION.md](docs/release/NOTARIZATION.md).

## Performance

The current architecture is built for large-cluster use: route-level code splitting, React Query cache reuse, virtualized logs, coalesced log stream updates, Rust-side watch streams, and local Tauri commands avoid a backend hop.

CI enforces bundle budgets for the main app chunk, terminal chunk, and workloads route with `npm run perf:bundle`.

## License

Apache-2.0
