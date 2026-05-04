# Lumen

Lumen is an open source desktop workbench for Kubernetes clusters. It gives operators and developers a fast local UI for cluster discovery, workload triage, logs, events, YAML inspection, port forwarding, Helm release operations, and pod shell sessions.

## Scope

Lumen is intentionally local-first:

- Reads cluster access from the user's kubeconfig.
- Talks directly to Kubernetes APIs from the Tauri app.
- Does not require a hosted backend, gateway, or SaaS account.
- Keeps cluster state and UI preferences on the user's machine.

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

Run checks:

```bash
npm run lint
npm run test
cargo test --manifest-path src-tauri/Cargo.toml
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Performance Direction

The current architecture is already pointed in the right direction for a cluster workbench: route-level code splitting, React Query cache reuse, virtualized logs, coalesced log stream updates, Rust-side watch streams, and local Tauri commands avoid a backend hop.

The next high-impact optimizations are:

- Keep all large lists virtualized, including CRD and event-heavy screens.
- Prefer watch-driven invalidation over frequent polling.
- Bound log buffers and event buffers per stream.
- Move CPU-heavy graph layout and security scans off the UI thread where practical.
- Add lightweight tracing around slow Kubernetes calls so unreachable contexts do not degrade the whole fleet view.

## License

Apache-2.0
