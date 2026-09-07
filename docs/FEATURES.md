# Lumen Features

Lumen is a local-first Kubernetes desktop workbench. It is built for operators
and developers who want a capable dashboard without routing cluster access
through a hosted control plane.

## Cluster Fleet

- Discover kubeconfig contexts and switch between clusters.
- Show cluster health, Kubernetes version, node readiness, and soft disconnects.
- Mark production-like contexts clearly so risky actions have stronger context.
- Inspect kubeconfig sources, definition precedence, and credential-tool availability from
  connection diagnostics, with separate guidance for authentication, TLS,
  network, and permission failures. Inspection does not execute credential tools.
- Merge all `KUBECONFIG` sources using Kubernetes first-definition-wins rules,
  including Windows path-list separators and source-relative credential paths.
  Context deletion and restoration retain source ownership.

## Workload Explorer

- Browse namespaces, workloads, services, storage, RBAC, policy, and custom
  resources from one desktop UI.
- Filter resources by name, namespace, kind, labels, status, images, restart
  count, and ownership.
- Open rich detail drawers with metadata, labels, owner references, events,
  YAML, pod state, metrics, and kind-specific insights.
- Remember namespaces per context, honor kubeconfig defaults, and enter a known
  namespace when discovery is denied. Workloads and triage retain successful
  results while explaining unavailable sources.

## Logs, Shell, And Port Forwarding

- Stream logs for pods and workload-owned pods with search, pause/resume, and
  bounded buffers.
- Open pod shell sessions through Kubernetes attach.
- Start and stop port forwards for pods and services from the local machine.

## Change And Incident Workflows

- Inspect rollout timelines, recent changes, events, alerts, and resource
  diffs.
- Generate incident reports with sensitive values redacted.
- Compare resources across clusters when troubleshooting drift.
- Investigate a selected triage issue with its failing container's current or
  retained previous logs, related events, and owner/controller snapshots. Export
  the selected evidence with capture times and unavailable-source notes.
- Investigation snapshots do not establish historical rollout causality. Event
  matching uses namespace, kind, and name; UID correlation and log contents are
  not included in the investigation report.

## Kubernetes Operations

- Protect selected contexts independently, with explicit ten-minute unlocks,
  persistent per-pane status, and native enforcement for cluster changes and
  pod shells. Protection survives restart; unlocks do not.
- Apply YAML only after successful server-side dry-run of the same draft,
  PATCH permission preflight, and confirmation. Both YAML entry points share
  these gates and respect the global read-only setting.
- Delete resources with confirmation and RBAC preflight checks.
- Manage Helm releases, including install, upgrade, rollback, and uninstall.
- Browse Argo CD applications, resource trees, history, and sync status.
- Inspect Tekton pipelines, pipeline runs, task runs, and status details.

See [protected contexts and kubeconfig sources](OPERATOR_SAFETY.md) for operation
and configuration details.

## Security Defaults

- Lumen reads the user's kubeconfig and talks directly to Kubernetes APIs.
- There is no hosted backend requirement.
- Secret YAML is redacted by default before rendering.
- Incident report exports redact obvious tokens, credentials, kubeconfig
  material, and secret values before report construction.
