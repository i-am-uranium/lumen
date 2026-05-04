# Lumen Design Notes

Lumen is a dense Kubernetes operations workbench. The interface should stay compact, readable, and optimized for repeated cluster triage rather than marketing presentation.

## Product Feel

- Dark terminal-style surfaces with clear borders and restrained color.
- Monospace text for resource names, namespaces, labels, YAML, logs, and command output.
- Green for active or healthy state, amber for caution, red for destructive or failed state.
- Full-height operational layouts over card-heavy pages.
- Stable row heights, fixed toolbars, and virtualized high-volume data.

## Core Screens

- Fleet: kubeconfig contexts, reachability, cluster health, node and workload totals.
- Cluster workspace: left rail for resource groups and a main route surface.
- Workloads: searchable, filterable Kubernetes resource lists.
- Resource drawer: YAML, events, logs, actions, and pod details.
- Logs: virtualized multi-source streams with bounded buffers.
- Shell dock: xterm.js pod attach sessions with tab management.
- Helm: release browser and action dialogs.
- Access control: optional Kubernetes RBAC helper for generated service-account access.

## Implementation Stack

- React 19 + TypeScript + Vite.
- Tauri 2 desktop shell.
- Rust command layer using kube-rs.
- Tailwind CSS with custom terminal tokens in `src/index.css`.
- TanStack Query for cache coordination.
- TanStack Virtual for large log/list rendering.
- xterm.js for interactive pod shells.

## Performance Rules

- Do not render unbounded arrays directly in React.
- Keep log append paths coalesced and capped.
- Use Kubernetes watches for freshness where available, with query invalidation as the UI contract.
- Avoid fleet-wide blocking calls on the UI thread.
- Treat unreachable contexts as partial failures, not global failures.
