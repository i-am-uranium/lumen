# Lumen Security Model

Lumen is a local-first Kubernetes desktop application. It reads kubeconfig credentials from the user's machine and talks directly to Kubernetes API servers through the local Tauri/Rust process. It must not require a hosted service, cloud account, shared dashboard token, or in-cluster agent for v1.0.

## Assets

- Kubernetes credentials in kubeconfig, including exec plugin output, client certificates, bearer tokens, and OIDC-derived credentials.
- Kubernetes API access to production clusters.
- Secret data, ConfigMap data, logs, events, YAML manifests, and generated kubeconfigs.
- Local user preferences and cached UI state.
- Release artifacts and update channels.

## Trust Boundaries

- Frontend renderer to Tauri command boundary.
- Tauri/Rust process to Kubernetes API server.
- Local filesystem access to kubeconfig and optional user-selected manifest files.
- Cluster-provided data rendered in the UI, including labels, annotations, events, logs, YAML, and CRD schemas.
- External commands invoked by kubeconfig exec plugins.
- Future plugin/MCP/local-process integrations, if implemented.

## Security Invariants

- Lumen never stores copied cluster credentials outside the user's existing kubeconfig or OS-approved storage.
- Lumen never sends cluster data to a hosted backend by default.
- Mutating actions require a Kubernetes RBAC preflight and a clear user confirmation.
- Secret values are masked by default and never included in logs, diagnostics, screenshots, or exports unless the user explicitly reveals or exports them.
- Production-like contexts are visually marked and require stronger confirmations for destructive actions.
- Untrusted cluster text is rendered as text, not HTML.
- Local files are read only through explicit user action or kubeconfig resolution.
- Release artifacts are built reproducibly where practical, signed/notarized where supported, and accompanied by checksums/SBOM.

## Mutating Action Requirements

Every create, apply, edit, patch, delete, scale, restart, trigger, shell, and port-forward action must:

1. Include context, namespace, kind, and object name in the confirmation surface.
2. Check capability through `SelfSubjectAccessReview` when possible.
3. Use server-side dry-run for create/apply/edit where the Kubernetes API supports it.
4. Show a diff for YAML mutations before sending the final request.
5. Handle conflicts with `resourceVersion` and ask the user to reload rather than overwriting silently.
6. Emit a local activity entry with timestamp, context, actor identity when available, action, target, and result.

## Secret Handling

- List and detail views show metadata and type first.
- Data values are masked by default.
- Reveal is per-field and temporary.
- Copy/export actions require explicit intent.
- Base64 decoding failures must not crash the UI.
- Secret values must be redacted from error reports and console logs.

## Shell, Logs, and Port Forwarding

- Pod shell and node shell must be RBAC-gated and visually scoped to context, namespace, pod, container, and command.
- Node shell is higher risk and requires a dedicated design before enabling.
- Logs must be bounded in memory, redacted for UI diagnostics, and never persisted automatically.
- Port forwards must show local bind address/port, remote target, owning context, and stop controls.

## Supply Chain Requirements

- Apache-2.0 license.
- `SECURITY.md` with disclosure process.
- Dependabot for npm and cargo where possible.
- CI gates: TypeScript, Vitest, Rust tests, formatting, cargo audit, npm audit, secret scanning, CodeQL.
- Release gates: signed macOS/Windows artifacts where credentials are configured, checksums, generated release notes, and draft release review.
- Third-party notices for bundled assets and dependencies before v1.0.

## Future Plugin / MCP Requirements

The current release has no AI assistant, Copilot, or model-provider process commands. Plugin runtime and MCP support are outside the core release. A future extension design requires:

- Permission manifest per extension.
- Explicit install trust prompt.
- No automatic local process execution.
- Sandboxed renderer execution where practical.
- Separate security review for filesystem, network, kubeconfig, and process-spawn permissions.

## Retired Assistant Data

Existing local assistant history and preferences are left untouched; this release does not automatically erase saved user content. The inactive keys are `lumen:ai:sessions`, `lumen:ai-assistant:settings`, and `lumen:copilot-ui`. Temporary `lumen-ai-context-*` session entries are also left alone. These values are no longer loaded by an assistant or sent to a model.

Old `/cluster/:context/ai` tabs redirect to workloads in the same cluster, preserving resource filters and existing query text as inert values. Saved runbook `ask-ai` steps become manual checklist steps when read; their prompts and notes remain available as instructions. Loading a runbook does not rewrite its stored data; normal subsequent edits save the migrated form.
