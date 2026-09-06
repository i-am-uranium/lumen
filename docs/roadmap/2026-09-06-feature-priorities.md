# Lumen: next development priorities

Research date: September 6, 2026. Repository baseline: `06cd5dc`, with the workflow-only update at `8462072` also inspected. Audience assumption: developers and operators using local kubeconfig credentials across development and production clusters.

Implementation note: the operator-workflows change implements the first increment
of priorities 1–3 and the two code defects below. This document preserves the
research baseline; see [Features](../FEATURES.md) for delivered behavior. Full
kubeconfig merging, per-context change policy, debug containers, network probes,
and installed-platform release validation remain follow-up work.

**Recommendation: make Lumen excellent at connecting, investigating a failing workload, and changing it safely.** Keep Copilot removed. For the next development cycle, prioritize namespace-scoped access, connection diagnostics, and a connected investigation workflow. Extend production controls before adding new mutation capabilities such as debug containers.

Three research tracks compared current implementations, upstream user reports, and Lumen source. The comparator set included Headlamp, Freelens, k9s, and the commercial desktop tool Aptakube. These are evidence-backed product hypotheses, not measured Lumen customer demand. The repository had no open issues when checked; we did not interview users or run competitors. Sizes are relative engineering estimates, not delivery dates.

## Fix before publishing the current release

These are existing behavior gaps, separate from the feature backlog:

- **Unify YAML safety across both editors.** The earlier readiness change gated the standalone editor, but the resource drawer has a separate reachable `YamlTab`. It checks `update` permission and allows real Apply without a successful dry-run of that exact draft. It also lacks the global read-only check in its edit eligibility. Reuse one editor/action implementation, check PATCH access, and test both entry points, changing targets, edited drafts, and read-only changes. The Kubernetes API still enforces RBAC; this is a Lumen workflow and permission-preflight defect. [Drawer implementation](https://github.com/ravirann/lumen/blob/06cd5dc/src/components/ResourceDetailDrawer.tsx#L1972), [Apply backend](https://github.com/ravirann/lumen/blob/06cd5dc/src-tauri/src/k8s/actions.rs#L648).
- **Correct Windows kubeconfig path handling.** `default_path()` splits on `:`, so a configured Windows drive-letter path is truncated. Add OS-appropriate path handling and regression fixtures before calling Windows support ready. Full multi-file merging is a larger follow-up. [Current loader](https://github.com/ravirann/lumen/blob/06cd5dc/src-tauri/src/k8s/kubeconfig.rs#L41), [Kubernetes path-list rules](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/#the-kubeconfig-environment-variable).
- **Complete installer and updater validation on each advertised platform.** Passing CI and a complete asset manifest do not prove installation, OS signing, or upgrade/relaunch. Retain the draft publication gate in the [release checklist](https://github.com/ravirann/lumen/blob/06cd5dc/docs/release/RELEASE_CHECKLIST.md). This research did not perform those platform tests.

## Ranked feature set

| Rank | Feature | User outcome | Scope | Timing |
|---|---|---|---|---|
| 1 | Namespace-scoped operator mode | Use Lumen with access to one namespace, without cluster-wide discovery rights | M | First increment |
| 2 | Connection diagnostics and kubeconfig source management | Understand and recover from connection failures; use real multi-file setups | M initially; L for full source management | Diagnostics first |
| 3 | A connected investigation workspace | Open an issue and follow its logs, events, owner rollout, and report without reselecting scope | M | First cycle |
| 4 | Per-context change policy and effective change review | Protect production independently and understand exactly what a change will do | M–L, staged | Before new mutation features |
| 5 | Ephemeral debug containers | Investigate crashing or shell-less containers through the existing terminal | M | After policy foundation |
| 6 | Complete network diagnosis | Explain source egress and destination ingress, then optionally verify live connectivity | M for policy analysis; L with probes | Policy analysis before probes |

### 1. Namespace-scoped operator mode

Lumen currently lists namespaces at cluster scope; the picker only offers returned names. Workloads and triage also default to broad queries. A user who can list pods in `payments` but cannot list namespaces can therefore be blocked by discovery even though useful operations are authorized. [Namespace API](https://github.com/ravirann/lumen/blob/06cd5dc/src-tauri/src/commands/k8s.rs#L182), [picker](https://github.com/ravirann/lumen/blob/06cd5dc/src/components/NamespacePicker.tsx#L57).

Build a shared per-context namespace selection, honor kubeconfig defaults, permit explicitly entering known namespaces, scope lists and watches, and retain successful panels when unrelated requests are forbidden. Do not require cluster-wide RoleBinding access merely to discover namespaces.

**Acceptance:** A fixture identity with pod/log access only in `payments`, and no Namespace or Node listing, can connect, browse, inspect and read logs through ordinary UI navigation. Forbidden data is explained as unavailable rather than shown as empty.

**Evidence:** [Headlamp #6015](https://github.com/kubernetes-sigs/headlamp/issues/6015) reports this exact discovery problem; [Headlamp 0.45.0](https://github.com/kubernetes-sigs/headlamp/releases/tag/v0.45.0) includes fetching configured namespaces individually when cluster-wide listing is forbidden. The issue is a demand signal, not a design to copy wholesale.

### 2. Connection diagnostics and kubeconfig source management

Context switching, probing, deletion and restoration already exist. Add an actionable first-run connection flow and distinguish missing config, missing credential executable, authentication failure, authorization denial, TLS failure and network timeout. Show where credentials/configuration came from without displaying secrets.

Stage full source management afterward: select multiple files, preserve relative references, expose duplicate-context precedence, track the owning file for edits/deletions, and invalidate cached clients when sources change. This requires a source model, not merely replacing a string split. [Loader](https://github.com/ravirann/lumen/blob/06cd5dc/src-tauri/src/k8s/kubeconfig.rs#L41), [client cache](https://github.com/ravirann/lumen/blob/06cd5dc/src-tauri/src/k8s/client.rs).

**Acceptance:** Missing `kubelogin` produces a specific recovery instruction; expired login is distinguishable from missing permissions; empty setup offers a source-selection action. Multi-file fixtures later match kubectl precedence and relative-path behavior across operating systems.

**Evidence:** [Freelens #1057](https://github.com/freelensapp/freelens/issues/1057), opened August 6, 2025 and still open at review, describes CLI tools working outside the GUI but not being found inside it. Kubernetes documents [external credential plugins](https://kubernetes.io/docs/reference/access-authn-authz/authentication/#client-go-credential-plugins) and [merged configuration rules](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/#merging-kubeconfig-files).

### 3. A connected investigation workspace

Triage, current/previous logs, events, rollout history, resource relationships and incident export already exist. The gap is carrying the same resource identity and time window through them. Triage currently links events by namespace, and its report supplies an empty rollout history. [Triage navigation](https://github.com/ravirann/lumen/blob/06cd5dc/src/routes/cluster/TriageView.tsx#L82), [report inputs](https://github.com/ravirann/lumen/blob/06cd5dc/src/routes/cluster/TriageView.tsx#L352).

**Acceptance:** Selecting a CrashLoop issue opens the failing container's previous logs, UID-related events and owner rollout. Panels show freshness and missing evidence. Export contains the same selected sources. Begin with one cluster and one workload; reuse existing panes and exporters.

**Evidence:** Kubernetes' [pod troubleshooting workflow](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/) combines these evidence types. Headlamp's [Projects](https://headlamp.dev/docs/latest/learn/projects/) demonstrate persistent resource grouping. Lumen's opportunity is reducing the steps between its existing views; a broad workspace rewrite is unnecessary.

### 4. Per-context change policy and effective change review

Extend the existing global read-only toggle with explicit per-context protection and temporary unlocking. Display the cluster in every confirmation and persistent session. Apply policy consistently to YAML, workload actions, Helm, Argo, Tekton and RBAC. Flag controller-managed resources and link to their owning release/application.

After the immediate editor fixes, offer full live-versus-server-dry-run comparison, including field-ownership conflicts. Native workload revision rollback can be a later slice; Helm rollback already exists. [Current settings](https://github.com/ravirann/lumen/blob/06cd5dc/src/state/uiSettings.ts), [shared preflight](https://github.com/ravirann/lumen/blob/06cd5dc/src/components/PreflightPreviewDialog.tsx).

**Acceptance:** Two `default/api` workloads in dev and production are unmistakably distinct. A protected context remains protected across every action entry point. Context or draft changes invalidate pending approval. Direct edits to GitOps-managed resources explain reconciliation behavior.

**Evidence:** [k9s #2613](https://github.com/derailed/k9s/issues/2613) describes separate protection for mixed environments; it was closed as not planned, so it is a use-case signal rather than proof of broad demand. [Argo self-healing](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/#automatic-self-healing) explains why direct edits may be reverted. [kubectl diff](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_diff/) establishes the effective-change comparison pattern.

### 5. Ephemeral debug containers

The existing shell executes inside an existing container. Add an explicit debug-container flow for workloads with no usable shell, reusing the shell dock. Select the target, image and suitable profile; show admission/RBAC failures and record the created container's identity. Do not default to privileged debug profiles. [Existing exec implementation](https://github.com/ravirann/lumen/blob/06cd5dc/src-tauri/src/k8s/exec.rs).

**Acceptance:** A distroless test workload can be investigated with a chosen debug image, with the cluster and target container visible. Denied creation fails clearly. The UI explains lifecycle limits rather than promising deletion of an individual ephemeral container.

**Evidence:** [Kubernetes ephemeral debugging](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/#debugging-with-an-ephemeral-debug-container) documents the missing-shell case. [Headlamp #3951](https://github.com/kubernetes-sigs/headlamp/issues/3951) is a completed upstream implementation precedent, and its [0.45.0 release](https://github.com/kubernetes-sigs/headlamp/releases/tag/v0.45.0) extends target selection.

### 6. Complete network diagnosis

The Network Debugger already handles selectors, endpoints, Ingress and ingress policy. Its policy model lacks egress. First add source-side egress, cross-namespace context and explicit unknown/incomplete outcomes. Then consider opt-in DNS/TCP/HTTP probes using the debug-container foundation. Keep observed results distinct from static inference. [Policy model](https://github.com/ravirann/lumen/blob/06cd5dc/src/lib/networkDebugger.ts#L100), [existing view](https://github.com/ravirann/lumen/blob/06cd5dc/src/routes/cluster/NetworkDebuggerView.tsx).

**Acceptance:** A source blocked by egress is never summarized as an allowed connection merely because destination ingress permits it. Missing permissions or unsupported policy/CNI behavior produce unknown results. Optional probes show where they executed and when.

**Evidence:** Kubernetes requires both applicable [egress and ingress policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/#the-two-sorts-of-pod-isolation) to permit a connection. Its [Service troubleshooting guide](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/) distinguishes configuration checks from DNS and endpoint reachability tests.

## Sequence and validation

1. Close the current release defects and complete platform installation/updater evidence.
2. Deliver namespace-scoped operation and connection diagnostics. Keep full multi-file editing in a separate increment.
3. Connect one workload investigation across existing views and export. Validate with CrashLoop, Pending and failed-rollout fixtures.
4. Extend per-context policy, then add ephemeral debugging. Improve static network analysis independently; add live probes afterward.

Before expanding scope, observe a small pilot group completing three tasks: connect with restricted credentials, explain a failing workload, and preview a production change. Record completion, time, backtracking and whether anyone needs broader permissions or a terminal workaround. These are proposed validation measures; no usage measurements were collected in this research.

Defer historical Prometheus metrics, richer CRD conditions/printer columns, and Tekton task-to-step logs until the core workflows are dependable. These have plausible value, but a smaller initial audience or larger integration cost. Do not rebuild generic Helm/Argo management, log streaming, metrics browsing, cross-cluster diffs or incident export: those already exist. A new AI assistant is outside the selected direction.
