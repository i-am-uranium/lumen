# Lumen: user pain, development priorities, and the 2027 outlook

Research date: 8 September 2026. Repository baseline: `30c3fddf620b9d78e3edca4f9572cc27ab6ad9f6` on `main`.

Status: research and product recommendation. These proposals are not implemented by this document. This assessment updates the priorities in [the September 6 roadmap](2026-09-06-feature-priorities.md); its outstanding connection and protection work has since landed.

## Recommendation

Make Lumen particularly good at helping an operator **find the failing part of a Kubernetes workflow, inspect the evidence, and take the next appropriate action**.

Prioritize request-path diagnosis and controlled debugging of containers without shells. Run a smaller incident-handoff experiment alongside them. Follow with controller-aware change review if users demonstrate that it reduces mistakes or tool switching. Investigate scheduling and capacity explanations for 2027 before committing to GPU-specific development.

This is a product judgment based on public reports, upstream changes, and repository fit. It is not a measured ranking of Lumen customer demand. Public evidence does not yet justify rebuilding the copilot, a hosted observability platform, or an autonomous cluster-remediation system.

## Who this serves

The initial working audience is application developers with namespace-limited access, on-call engineers investigating unfamiliar workloads, and small platform teams maintaining several clusters. Their recurring tasks are more useful prioritization units than an inventory of Kubernetes resource kinds:

- A service is unreachable; locate the broken relationship and the evidence supporting that conclusion.
- A production image has no shell; get the appropriate diagnostic environment without rebuilding it.
- A colleague needs help; share the relevant evidence without requiring them to reconstruct the investigation.
- A controller keeps changing a resource; understand who manages it and where a durable change belongs.
- A workload is pending despite apparently available capacity; identify the admission or placement constraint.

These audience choices remain assumptions to validate. The public research does not establish their share of Lumen's users.

## What users actually reported

Issue states below were checked during this research. A closed issue can demonstrate a real workflow, but it is not evidence of an unresolved competitor gap. Reactions and comments were not treated as independent customer counts.

| Evidence | Observed pain | Interpretation and limitation |
| --- | --- | --- |
| [Freelens #687: workload logs](https://github.com/freelensapp/freelens/issues/687), opened May 2025; open | Users want logs across deployment/stateful-set pods with container filtering. July 2026 comments describe dependence on this workflow, failed extension attempts, and one offer to contribute to a bounty. | Strong concrete workflow and switching-friction signal. One bounty offer is not established willingness to pay across a market. Lumen already supports aggregate workload logs. |
| [Freelens #1170: selection lost while scrolling](https://github.com/freelensapp/freelens/issues/1170), opened September 2025; open | A collaborator describes finding an error and copying it to a colleague. A January 2026 commenter reports switching to Headlamp over unreliable copying. | Small interaction failures can undermine the whole product. Supports testing evidence handoff. It does not establish that Lumen has the same bug. |
| [Freelens #2095: previous-container logs selected by default](https://github.com/freelensapp/freelens/issues/2095), July 2026; closed with a linked fix | The initial log view could show the terminated container instance unexpectedly. | Evidence identity matters. Treat this as an upstream-fixed regression example, not a feature advantage to advertise. |
| [Freelens #2409: missing metric history on autoscaled clusters](https://github.com/freelensapp/freelens/issues/2409), August 2026; open | The reporter's chart filtered history through currently existing nodes, hiding retained data from nodes that had disappeared. | Historical membership and live membership differ. This is one reported environment, not a prevalence estimate or a demand signal for Lumen to store all metrics. |
| [Headlamp #3951: ephemeral debugging](https://github.com/kubernetes-sigs/headlamp/issues/3951), September 2025; closed February 2026 | A user cannot obtain a terminal in distroless, scratch, or crashed containers and requests a configurable debug image. | Direct use case with clear boundaries. Headlamp has acted on it, so this is useful competitive parity rather than a novel category. |
| [Cilium #37778: cross-namespace Gateway TLS reference](https://github.com/cilium/cilium/issues/37778), February 2025; closed August 2025 | A user interprets a rejected secret reference as missing support. A maintainer explains that a ReferenceGrant is required. | Valuable explainability example: configuration can look like a platform defect. This was not confirmed as an unresolved Cilium bug. |
| [Argo CD #29160: source origin for generated resources](https://github.com/argoproj/argo-cd/issues/29160), August 2026; open | A user wants resource-to-source provenance and an eventual Open in Git action. Human discussion notes that generated Helm/Kustomize/plugin output may not map to one source file. | Supports source-aware investigation, with moderate confidence. Ignore the automated AI triage comment as demand evidence. Do not promise exact source paths for all generated manifests. |
| [Freelens #2250: repeated authorization discovery](https://github.com/freelensapp/freelens/issues/2250), July 2026; open | A reporter describes excessive per-namespace authorization-review requests against a webhook authorizer. | Permission discovery and API load are product quality concerns. The reporter's proposed shortcut is not an authoritative security design. |

Broader [production-incident discussion on r/kubernetes](https://www.reddit.com/r/kubernetes/comments/1r7t6lv/what_actually_goes_wrong_in_kubernetes_production/) includes difficulty separating workload failures from node, dependency, networking, and resource problems. Other participants say their systems usually work well or that existing provider tools help. This is useful qualitative context, not a representative survey, and does not establish a need to replace those tools.

The clearest lesson is that task continuity matters: selecting the correct instance, following a workload, understanding references, and giving another person enough evidence to help. Feature breadth alone would not address those complaints.

## Avoid rebuilding what already exists

The repository check changed the earlier feature framing:

| Current Lumen capability | Source | Remaining opportunity |
| --- | --- | --- |
| Workload/multi-container logs, current and previous logs, reconnecting streams; selector streams discover replacement pods and track UID changes | [Native log implementation](../../src-tauri/src/k8s/logs.rs), [log viewer](../../src/components/logs/LogsViewer.tsx) | Verify selection/copy reliability and context labels; connect selected evidence to investigation export. Do not propose rollout-following logs as new. |
| GatewayClass, Gateway, HTTPRoute, and GRPCRoute resource registration | [Native resource registry](../../src-tauri/src/k8s/registry.rs), [frontend registry](../../src/lib/k8s/resourceRegistry.ts) | Explain attachment, references, controller conditions, and backend relationships. Basic Gateway lists already exist. |
| Local Service/EndpointSlice/Ingress and ingress-policy analysis | [Network evaluator](../../src/lib/networkDebugger.ts), [network view](../../src/routes/cluster/NetworkDebuggerView.tsx) | Source egress, cross-namespace evaluation, and Gateway relationships are meaningful additions. |
| Investigation export with current resource/controller observations and explicit source availability | [Investigation component](../../src/components/TriageInvestigation.tsx) | Events currently match kind/name within namespace, without UID correlation. Reports exclude log contents and historical rollout revisions. Extend evidence integrity and selected capture. |
| Server dry-run output and an operational change summary | [YAML modal](../../src/components/YamlModal.tsx), [smart diff](../../src/lib/smartDiff.ts) | The summary displays the first six changes; managedFields are excluded as noise. Add a complete review and a separate ownership explanation if validated. |
| Native exec, protected contexts, namespace-scoped workflows, multiple kubeconfig sources, Helm and Argo CD workflows | [Feature documentation](../FEATURES.md) | Reuse these foundations. Connection/protection work is no longer an unimplemented roadmap item. |

This was source inspection, not a fresh interactive usability test. In particular, competitor log-copy complaints are a reason to test Lumen, not a verified Lumen defect.

## Priorities and bounded first versions

The ordering uses severity of the demonstrated task, strength of public evidence, fit with existing code, and maintenance burden. Effort is relative; these are not delivery estimates or numerical RICE scores.

| Order | Investment | Demand confidence | Fit / effort | Decision |
| --- | --- | --- | --- | --- |
| 1 | Explain an unreachable request path | Medium-high: user confusion plus a concrete ecosystem migration | Strong fit; medium-to-large, split into increments | First development track |
| 2 | Debug a container without a shell | High confidence in the use case; Lumen adoption impact unmeasured | Strong fit; medium | Second independent track |
| 3 | Share a trustworthy incident excerpt | High confidence in copying/handoff pain; medium-low for a new bundle/viewer | Strong fit; small pilot, larger if expanded | Prototype and validate before a broad build |
| 4 | Explain controller ownership before changing a resource | Moderate public evidence; strong operational rationale | Good fit; medium | Next, contingent on observed workflows |
| 5 | Explain pending work and unusable capacity | Strong upstream direction; limited direct evidence for Lumen's audience | Partial fit; large if vendor-specific | 2027 discovery, beginning with ordinary workloads |

### 1. Request-path diagnosis

**User outcome:** given a source workload and destination service or route, identify the first supported explanation for failure and the next useful check.

Start by completing source egress and destination ingress evaluation, including namespace selectors and ports. Kubernetes requires both sides to permit a connection where both are isolated; ingress-only reasoning is incomplete. Preserve uncertainty for unsupported policy types, insufficient permissions, and behavior outside the evaluator. [Kubernetes NetworkPolicy semantics](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

Then connect Gateway listeners and route parent references to backends, EndpointSlices, and ready pods. Explain missing or rejected references, ReferenceGrants, and stale conditions. Include Accepted, ResolvedRefs, Programmed, and observedGeneration with the relevant object and controller. A missing status is not a success: an invalid parent may leave a route outside any controller's scope. [Gateway API troubleshooting](https://gateway-api.sigs.k8s.io/docs/concepts/troubleshooting/)

Present inferred configuration results separately from observed traffic results. A green policy calculation or Programmed condition cannot establish real DNS, TLS, cloud load-balancer, CNI, or application reachability. Active DNS/TCP probes can follow after the debug-container foundation; do not make them a prerequisite for the read-only first version.

Acceptance scenarios: missing backend, no ready endpoints, rejected cross-namespace reference, egress denial, restricted namespace access, stale status, and a correctly configured path with an external failure. The last case must retain uncertainty instead of inventing a root cause.

### 2. Controlled ephemeral debugging

**User outcome:** inspect a shell-less workload using a chosen diagnostic image, with clear target and permissions.

Add a debug action beside native exec. Let users choose the target container, image, command, and supported security profile. Show the context and namespace throughout; enforce existing native protection and report RBAC/admission failures. Reuse the terminal rather than build a second terminal subsystem.

Kubernetes provides ephemeral containers for this class of investigation. Their lifecycle differs from normal containers: they cannot be individually restarted or removed after addition. Target-process visibility and access to the application's filesystem depend on runtime and configuration; an attached debug image is not a universal filesystem or memory-debugging solution. [Ephemeral container documentation](https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/)

The first version should avoid privileged defaults and node-debugging scope. Validate distroless targets, denied access, protected contexts, image-pull failure, unsupported target visibility, termination, and reopening an existing diagnostic session. Success means completing an investigation without a rebuild or copying an error-prone command between tools.

### 3. Incident handoff pilot

**User outcome:** send a colleague a small, understandable excerpt that preserves which object and container instance it came from.

Extend the existing investigation export with explicitly selected log excerpts, UID-aware resource/event references, capture times, current/previous container selection, and unavailable/truncated-source indicators. Provide an export preview, bounded collection, and redaction controls. Logs may contain sensitive values even when metadata is safe; automated redaction cannot guarantee their absence.

Start with a readable local artifact that requires no account or cluster connection to understand. Test that before implementing a full offline replay application. Preserve source identities and distinguish current observations from captured history; do not infer that a rollout caused an incident just because both appear nearby.

A desktop client cannot recover logs that the cluster has already discarded. Kubernetes exposes limited container-log retention, and eviction can remove the local logs entirely. Longer history requires an existing logging backend or an explicitly designed recorder. [Kubernetes logging architecture](https://kubernetes.io/docs/concepts/cluster-administration/logging/)

Acceptance scenario: the receiving engineer can identify the target, summarize the evidence and its gaps, and choose a next check without contacting the sender for basic context. If a reliable copy/export interaction solves the task, stop there.

### 4. Controller-aware change review

**User outcome:** understand the complete proposed change and whether an upstream controller will overwrite it.

Extend the existing dry-run UI with complete before/after review, validation failures, and a separate ownership/source section. Use verified owner references, field managers, and existing Helm/Argo information. Link to a Git origin only when available; explicitly retain unknown or multi-source provenance.

Argo CD already supports server-side diff, so a generic diff viewer is weak differentiation. Lumen's possible advantage is carrying the operator from investigation to an appropriate durable change without losing context. [Argo CD diff strategies](https://argo-cd.readthedocs.io/en/stable/user-guide/diff-strategies/)

Do not equate managedFields with a human audit trail, promise impact prediction from a diff, or label a successful dry-run as runtime safety. Validate this investment against real examples of reverted manual edits and confusing controller ownership.

### 5. Scheduling and capacity explanations

**User outcome:** explain why a workload cannot run even though a high-level dashboard appears to show capacity.

Begin with Pending pods, scheduler events, resource requests, taints/tolerations, affinity, storage binding, and quota. Add Kueue, PodGroup, or DRA adapters only for users who run them. Preserve controller-reported reasons, source timestamps, API availability, and missing evidence rather than attempting a second scheduler.

Require design partners with actual batch or accelerator incidents before building GPU-specific screens. An inspected [Kueue scheduling report](https://github.com/kubernetes-sigs/kueue/issues/8064) was closed the same day without explanatory comments returned by the API; it is insufficient evidence of an ongoing product gap. Upstream feature development is a stronger reason to investigate this area than that isolated issue.

## How 2027 may change the problem

These are forecasts, not announced industry outcomes or committed Lumen scope.

| Observed fact as of September 2026 | 2027 hypothesis and confidence | Lumen response / what would change the decision |
| --- | --- | --- |
| The Kubernetes committees set March 2026 as ingress-nginx retirement, ending updates. CERN's subsequent migration account describes controller/annotation dependencies and third-party chart constraints. [Official statement](https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/), [end-user migration experience](https://www.cncf.io/blog/2026/04/02/ingress-nginx-retirement-experience-from-end-users/) | High confidence that heterogeneous routing and migration questions remain relevant into 2027; uncertain how long each user retains legacy setups. Retirement concerns the community ingress-nginx controller, not the Ingress API or every NGINX product. | Build durable relationship/condition explanations that serve mixed setups. Reduce migration-specific work if target users have already standardized and their controller tooling solves the task. |
| Kubernetes 1.37 advances DRA, including stable extended-resource support. Kubernetes 1.36 introduced revised Workload/PodGroup APIs at alpha maturity. [DRA update](https://kubernetes.io/blog/2026/09/03/kubernetes-v1-37-dra-updates/), [workload scheduling update](https://kubernetes.io/blog/2026/05/13/kubernetes-v1-36-advancing-workload-aware-scheduling/) | High confidence in growing scheduling complexity; medium confidence in meaningful adoption among Lumen's target users by 2027. Today's alpha features are not guaranteed to be stable then. | Develop the general pending-work explanation first; gate specific API integrations by discovery and version. Defer GPU specialization if design partners lack recurring problems. |
| CNCF's 2025 survey reports production Kubernetes use among 82% of surveyed container users. Of organizations hosting generative models, 66% use Kubernetes for some or all inference; 44% of respondents do not run AI/ML workloads on Kubernetes. [Survey announcement](https://www.cncf.io/announcements/2026/01/20/kubernetes-established-as-the-de-facto-operating-system-for-ai-as-production-use-hits-82-in-2025-cncf-annual-cloud-native-survey/) | AI workloads are a credible adjacent segment, not a reason to assume every Kubernetes operator needs an AI-specific dashboard. Confidence in broad direction is higher than confidence in Lumen demand. | Interview both ordinary application teams and AI/batch operators. Do not let the latter dominate the roadmap without evidence. Survey respondents are not a representative sample of Lumen users. |
| A current user report shows node churn hiding retained history in a dashboard. | Medium confidence that transient infrastructure will make evidence identity and retention boundaries more important. This is an inference, not a measured growth rate. | Capture exact identities and timestamps now. Integrate historical backends only when users need them; never substitute current membership for historical membership. |
| The 2026 State of FinOps survey identifies workload optimization and waste reduction as the leading single current priority. Its respondents are heavily enterprise-oriented. [FinOps survey](https://data.finops.org/) | Cost scrutiny likely persists, but demand for another standalone cost dashboard among Lumen users is unproven. | Explain resource constraints and link existing telemetry first. Require historical usage and pricing/allocation inputs before any savings estimate; do not derive costs from instantaneous CPU alone. |
| Kubernetes has introduced an Agent Sandbox project for agent execution. [Upstream introduction](https://kubernetes.io/blog/2026/03/20/running-agents-on-kubernetes-with-agent-sandbox/) | Conditional, medium-confidence forecast: more automated actors increase the usefulness of inspectable evidence and clear ownership. This does not prove a demand for chat in Lumen. | Keep evidence and action boundaries explicit. Reconsider assistant features only for a validated workflow with measurable benefit and trustworthy source attribution. |

## What to defer

- **A general AI copilot or autonomous repair:** this research has not established a missing user workflow that requires either. Existing protection and deterministic explanations are immediately reusable.
- **A generic log aggregator, Gateway list, or dashboard expansion:** Lumen already covers much of this; [Stern](https://github.com/stern/stern) and other established tools also cover multi-pod logs. Improve task completion rather than count screens.
- **A full observability or FinOps backend:** ingestion, retention, billing, and historical correctness create a substantially different product. Connect to users' existing systems when a concrete integration is justified.
- **An automatic Ingress migration engine:** resource conversion is separate from proving application behavior after migration. Start with diagnosis and documented relationships.
- **A broad GPU operations console or multi-cluster scheduler:** upstream momentum is not enough to establish demand, supported environments, or maintenance capacity.

## Validate before expanding the investment

Public research chooses promising experiments. It cannot replace observing actual users. No interviews, usability sessions, or Lumen usage analysis were conducted for this report.

Recruit 8–12 operators across namespace-limited application teams, small platform/on-call teams, and a smaller AI/batch cohort. Ask them to reconstruct their last relevant incident using their current tools. Record the trigger, permissions, commands, evidence lost, handoffs, and time spent. Avoid asking whether they like a feature description.

Use 5–8 task-based prototype sessions for the first increments. Compare Lumen with each participant's usual kubectl, Headlamp, Freelens, or provider workflow. Measure task completion, time to an evidence-supported explanation, incorrect conclusions, and required context switches. For handoff, include a receiving engineer who did not see the original investigation.

Suggested decision gates, to agree before testing rather than retrofit afterward:

1. Confirm recurring pain with at least two independent target teams or a concrete ecosystem change plus a committed design partner. Multiple comments from one issue do not automatically satisfy this.
2. Write the exact current Lumen gap, existing alternatives, smallest useful increment, and known uncertainty.
3. Require users to complete the target task and explain why the result is supported. A faster incorrect diagnosis is a failure.
4. Continue expansion only when participants prefer the workflow for a demonstrated reason. Stop or narrow it when existing tools already solve the task adequately.
5. Recheck public issue status and API maturity before implementation. Archive outdated assumptions in a dated decision note.

Development can then proceed as two bounded parallel tracks: network diagnosis and ephemeral debugging. Keep the handoff pilot small until receiving-user tests support expansion. Each track needs native/backend checks, restricted-access scenarios, and the existing release and bundle-budget gates. Reliable connection, log handling, and installation remain release requirements throughout.

## Research method and limits

The search covered public complaints in Freelens, Headlamp, Cilium, Argo CD, Kueue, and Kubernetes community discussions; upstream Kubernetes/Gateway documentation; CNCF end-user and survey material; and the State of FinOps report. Searches included workload logs, log-copy failures, distroless debugging, Gateway cross-namespace failures, resource provenance, autoscaling history, and scheduling/AI infrastructure changes.

Primary issue bodies and human follow-up comments were used for user pain. Official documentation was used for technical semantics. Vendor/member posts and automated triage were not treated as independent validation. The full CNCF survey PDF could not be retrieved through the browser; the cited statistics come from its official announcement, not an asserted full-report review.

Selection bias is substantial: public OSS issue reporters are unusually engaged, closed reports can remain highly searchable, and adjacent tools have different audiences. This report does not estimate market size, prevalence, conversion, willingness to pay, or future adoption rates. The proposed order is the best current product judgment to test, with explicit reasons to change it.
