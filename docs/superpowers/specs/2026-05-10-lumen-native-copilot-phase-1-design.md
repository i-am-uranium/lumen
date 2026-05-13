# Lumen Native Copilot Phase 1 Design

## Goal

Build the first true native Copilot layer inside Lumen: a read-only Kubernetes resource resolver and evidence collector that powers the floating Copilot drawer with real cluster context instead of brittle phrase-to-route mapping.

External OSS projects such as K8sGPT, HolmesGPT, and kagent are useful references for investigation patterns, analyzer categories, and safety boundaries, but Phase 1 must not depend on them at runtime.

## Problem

The current Copilot PR proves the UX direction: floating drawer, session persistence, read-only CTAs, and navigation handoff. The gap is that it still behaves like an intent router:

- It guesses resource names from phrases.
- It has limited namespace awareness.
- It does not gather evidence before answering.
- It cannot explain why a resource is unhealthy from live Kubernetes state.
- Every new phrase adds more classifier complexity.

To become a real operator Copilot, Lumen must own native resource resolution and evidence collection.

## Product Direction

Build **Lumen Native Copilot Phase 1: Resolver + Evidence Cards**.

When an operator asks for logs, asks why something is failing, asks about a deployment, or references an application by natural language, Copilot should:

1. Parse the prompt into a broad read-only intent.
2. Resolve referenced resources from the live cluster.
3. Show exact matches or candidate choices with namespace/kind/name.
4. Collect lightweight evidence for the selected target.
5. Render evidence-backed cards and exact navigation CTAs.
6. Save the investigation into existing AI session history.

## Scope

### In Scope

- Native resource resolver for:
  - deployments
  - pods
  - services
  - ingresses
  - statefulsets
  - daemonsets
  - jobs
  - ArgoCD applications when available through existing Lumen APIs
  - Helm releases when available through existing Lumen APIs
- Phrase normalization:
  - `customer service` -> `customer-service`
  - case-insensitive matching
  - hyphen/space/underscore tolerant matching
  - partial/fuzzy ranking for candidates
- Namespace-aware resolution:
  - prefer current route namespace
  - search all namespaces when namespace is missing
  - show disambiguation when multiple candidates match
- Evidence collection for Kubernetes workload targets:
  - workload summary
  - related pods
  - pod readiness
  - restart counts
  - recent warning/error events
  - latest log CTA target
  - related service/ingress candidates when cheap to collect
- Copilot drawer response changes:
  - resolved target card
  - candidate picker when ambiguous
  - evidence cards
  - confidence/reason text
  - exact CTA cards to Logs, Events, Workloads, Rollout Timeline, ArgoCD, or Helm
- Read-only policy enforcement for every resolver/evidence step.
- Tests for resolver ranking, ambiguous matches, no matches, and evidence card construction.

### Out of Scope

- Runtime dependency on K8sGPT, HolmesGPT, kagent, or MCP servers.
- Autonomous tool calling.
- Mutating actions from Copilot.
- Full LLM-driven planning.
- Long-running background watch sessions.
- Team/shared server-side Copilot sessions.
- Deep metrics correlation unless the data is already available from existing Lumen route APIs.

## Native Architecture

### 1. Intent Layer

Keep intent classification broad and conservative. It should identify the operator's general goal, not hard-code every possible phrase.

Proposed intents:

- `logs`
- `investigate`
- `explain-resource`
- `rollout`
- `network`
- `incident-update`
- `argocd-app`
- `helm-release`
- `mutation-request`
- `unknown`

Mutation requests remain read-only handoffs. For example, "restart customer service" should resolve `customer-service`, explain that Copilot cannot mutate, and show a CTA to the existing guarded restart/preflight flow if appropriate.

### 2. Resource Resolver

Add a native resolver module that accepts:

- cluster context
- prompt text
- optional namespace
- optional route/resource context
- intent hint

It returns:

- status: `resolved`, `ambiguous`, or `not_found`
- candidates
- best match when confidence is sufficient
- confidence score
- match reasons
- suggested fallback CTAs

Candidate shape:

```ts
type CopilotResolvedResource = {
  id: string;
  kind: string;
  namespace: string;
  name: string;
  displayName: string;
  source: "kubernetes" | "argocd" | "helm";
  score: number;
  reasons: string[];
};
```

Resolution should be deterministic and testable. It should use existing `k8s.listWorkloads`, ArgoCD, and Helm client APIs rather than shelling out.

### 3. Evidence Collector

Add a read-only collector that accepts a resolved target and gathers cheap, relevant facts.

For workload-like targets:

- target summary
- child pod summaries
- restart totals and largest restart count
- readiness state
- recent events for the target/pods
- log route target
- workload detail route target

Evidence shape:

```ts
type CopilotEvidenceBundle = {
  target: CopilotResolvedResource;
  health: "healthy" | "degraded" | "failed" | "unknown";
  facts: CopilotEvidenceFact[];
  warnings: CopilotEvidenceFact[];
  ctas: CopilotCta[];
  collectedAt: string;
};
```

The collector should prefer bounded, low-cost calls. Phase 1 should avoid fetching large logs into the drawer; it should route to Logs with a precise preselection instead.

### 4. Response Builder

Replace the current logs/Argo route-only response builder with a native response builder:

1. classify intent
2. resolve resource
3. if ambiguous, show candidates
4. if resolved, collect evidence
5. build cards and CTAs
6. persist session

The response should be useful without an LLM. A later phase can use the existing AI provider as a summarizer over the evidence bundle, but Lumen should gather the facts first.

### 5. UI Behavior

#### Resolved

Show:

- "Found deployment/customer-service in checkout"
- confidence/reasons
- health summary
- evidence cards
- CTAs:
  - Open logs
  - Open events
  - Open workload
  - Open rollout timeline when relevant

#### Ambiguous

Show:

- "I found 3 possible matches"
- candidate cards with namespace/kind/health
- selecting a candidate runs evidence collection for that target

#### Not Found

Show:

- normalized search phrase
- where Copilot searched
- CTAs:
  - Open Workloads search
  - Open Logs search
  - Open Events search

## Safety

- Phase 1 is read-only.
- Resolver and evidence collectors can only call allowlisted read-only APIs.
- Every CTA has `readOnly: true` unless it is explicitly a handoff to an existing guarded action page.
- Mutating prompts never run cluster actions from Copilot.
- Evidence persistence must avoid raw secret YAML, token values, and large log payloads.

## Testing

### Unit

- prompt phrase normalization
- resource scoring and ranking
- namespace preference
- ambiguous result handling
- no-match result handling
- CTA generation from resolved resources
- evidence bundle construction

### Component

- drawer renders resolved target card
- drawer renders ambiguous candidate choices
- selecting a candidate updates evidence cards
- logs request opens Logs with `ns`, `kind`, and `name`
- mutation request shows read-only handoff, not an execute button

### Integration

- mocked Kubernetes API resolution across namespaces
- evidence collection for deployment with pods/events
- existing AI session persistence still works

## Acceptance Criteria

- "fetch customer service logs" resolves a real workload candidate before showing a Logs CTA.
- If one exact workload match exists across namespaces, Copilot shows it and opens Logs with namespace/kind/name preselected.
- If multiple matches exist, Copilot asks the operator to choose rather than guessing.
- "why is customer service failing?" returns evidence cards based on pod readiness/restarts/events.
- "restart customer service" does not mutate and instead shows a read-only explanation plus a guarded CTA.
- No external agent runtime is required.
- Existing PR #66 Copilot drawer/session behavior remains intact.

## Future Phases

- Phase 2: deeper investigation planner for rollout, network, and incident flows.
- Phase 3: optional LLM summarization over native evidence bundles.
- Phase 4: richer source integrations for Prometheus/Loki/Alertmanager when configured.
- Phase 5: native policy engine for controlled mutation handoffs.
