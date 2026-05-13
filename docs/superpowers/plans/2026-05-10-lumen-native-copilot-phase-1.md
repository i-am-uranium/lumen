# Lumen Native Copilot Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current route-only Copilot response path with native, read-only Kubernetes resource resolution and evidence cards.

**Architecture:** Keep the existing floating drawer, session store, and CTA components. Add focused pure modules for prompt target extraction/scoring, an async resolver that uses existing Lumen `k8s` APIs, an async evidence collector for resolved resources, and a response builder that returns resolved/ambiguous/not-found states for the drawer. No runtime dependency on K8sGPT, HolmesGPT, kagent, or MCP servers.

**Tech Stack:** React, TypeScript, Vitest, TanStack Query-style async clients, existing `src/lib/k8s.ts`, existing Copilot UI/session modules.

---

## Files

- Create: `src/lib/copilotResourceResolver.ts`
  - Native phrase normalization, scoring, and async resource lookup.
- Create: `src/lib/copilotResourceResolver.test.ts`
  - Resolver tests for exact match, namespace preference, ambiguity, and no-match fallback.
- Create: `src/lib/copilotEvidence.ts`
  - Read-only evidence bundle builder for resolved Kubernetes targets.
- Create: `src/lib/copilotEvidence.test.ts`
  - Evidence tests for pod readiness/restarts/events/CTA construction.
- Modify: `src/lib/copilotAssistant.ts`
  - Add async native response builder while keeping existing response shape compatible enough for session rendering.
- Modify: `src/lib/copilotAssistant.test.ts`
  - Add native response tests for resolved, ambiguous, not-found, and mutation-handoff paths.
- Modify: `src/components/copilot/CopilotDrawer.tsx`
  - Submit prompts through the async native response builder, show loading/errors, candidates, target card, and evidence cards.
- Modify: `src/components/copilot/CopilotDrawer.test.tsx`
  - Cover resolved target card, ambiguous candidates, and exact Logs CTA.
- Modify: `src/lib/copilotIntent.ts`
  - Broaden intent set enough for mutation/investigate/logs routing.
- Modify: `src/lib/copilotIntent.test.ts`
  - Add mutation and investigate target extraction coverage.
- Modify: `src/lib/copilotNavigation.ts`
  - Add CTA helpers for Workloads search/resource routes and mutation handoff route metadata if needed.
- Modify: `src/lib/copilotNavigation.test.ts`
  - Cover new CTA builders.

---

## Chunk 1: Native Resolver Core

### Task 1: Resource Phrase Normalization and Scoring

**Files:**
- Create: `src/lib/copilotResourceResolver.test.ts`
- Create: `src/lib/copilotResourceResolver.ts`

- [ ] **Step 1: Write failing tests**

Test public pure helpers:

```ts
expect(normalizeCopilotResourcePhrase("customer service")).toBe("customer-service");
expect(scoreCopilotCandidate("customer service", {
  kind: "deployment",
  namespace: "checkout",
  name: "customer-service",
  health: "healthy",
  ready: "2/2",
  labels: {},
  age_seconds: 60,
})).toMatchObject({ score: 100 });
```

Also test that `customer service` scores `customer-api` lower than `customer-service`.

- [ ] **Step 2: Verify RED**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test -- src/lib/copilotResourceResolver.test.ts
```

Expected: fails because resolver module does not exist.

- [ ] **Step 3: Implement pure helpers**

Export:

```ts
export type CopilotResolvedResource = {
  id: string;
  kind: WorkloadKind | "argocdapplication" | "helmrelease";
  namespace: string;
  name: string;
  displayName: string;
  source: "kubernetes" | "argocd" | "helm";
  score: number;
  reasons: string[];
  health: Health;
  ready?: string;
};

export function normalizeCopilotResourcePhrase(value: string): string;
export function scoreCopilotCandidate(query: string, workload: WorkloadSummary): {
  score: number;
  reasons: string[];
};
```

Scoring minimum:

- exact normalized name match: 100
- exact display text match: 95
- starts-with match: 80
- includes match: 60
- label `app.kubernetes.io/name` or `app` exact match: +10 bonus

- [ ] **Step 4: Verify GREEN**

Run focused test again.

### Task 2: Async Kubernetes Resource Resolver

**Files:**
- Modify: `src/lib/copilotResourceResolver.test.ts`
- Modify: `src/lib/copilotResourceResolver.ts`

- [ ] **Step 1: Write failing resolver tests**

Create an injected client:

```ts
const client = {
  listWorkloads: vi.fn(),
  listArgocdApplications: vi.fn(),
  listHelmReleases: vi.fn(),
};
```

Test:

- one exact deployment across all namespaces returns `status: "resolved"`
- two exact deployments in different namespaces returns `status: "ambiguous"`
- current namespace exact match outranks cross-namespace match
- no match returns `status: "not_found"` with searched kinds.

- [ ] **Step 2: Verify RED**

Run the resolver test file. Expected: fails for missing async resolver.

- [ ] **Step 3: Implement async resolver**

Export:

```ts
export type CopilotResolveStatus = "resolved" | "ambiguous" | "not_found";

export type CopilotResolveRequest = {
  context: string;
  query: string;
  namespace?: string;
  intent?: CopilotIntentKind;
  kinds?: WorkloadKind[];
};

export type CopilotResolveResult = {
  status: CopilotResolveStatus;
  query: string;
  normalizedQuery: string;
  searchedKinds: string[];
  candidates: CopilotResolvedResource[];
  selected: CopilotResolvedResource | null;
};

export async function resolveCopilotResource(
  request: CopilotResolveRequest,
  client?: CopilotResolverClient,
): Promise<CopilotResolveResult>;
```

Implementation:

- default client wraps `k8s.listWorkloads`, `k8s.listArgocdApplications`, `k8s.listHelmReleases`
- Kubernetes kinds for Phase 1: deployment, pod, service, ingress, statefulset, daemonset, job
- use empty namespace to search all namespaces when request namespace is missing
- prefer request namespace by score bonus
- resolved when top score >= 90 and second candidate is meaningfully lower or absent
- ambiguous when multiple high-confidence candidates remain
- not_found when no candidate score >= 50

- [ ] **Step 4: Verify GREEN**

Run resolver tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/copilotResourceResolver.ts src/lib/copilotResourceResolver.test.ts
git commit -m "feat: add native copilot resource resolver"
```

---

## Chunk 2: Evidence Collector

### Task 3: Workload Evidence Bundle

**Files:**
- Create: `src/lib/copilotEvidence.test.ts`
- Create: `src/lib/copilotEvidence.ts`

- [ ] **Step 1: Write failing tests**

Test a resolved deployment with two pods:

- health becomes `degraded` when one pod is unhealthy
- warnings include restart count and warning events
- CTAs include Logs, Events, and Workload

- [ ] **Step 2: Verify RED**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test -- src/lib/copilotEvidence.test.ts
```

- [ ] **Step 3: Implement collector**

Export:

```ts
export type CopilotEvidenceFact = {
  id: string;
  severity: "info" | "warning" | "critical";
  label: string;
  value: string;
  detail?: string;
};

export type CopilotEvidenceBundle = {
  target: CopilotResolvedResource;
  health: Health;
  facts: CopilotEvidenceFact[];
  warnings: CopilotEvidenceFact[];
  ctas: CopilotCta[];
  collectedAt: string;
};

export async function collectCopilotEvidence(
  context: string,
  target: CopilotResolvedResource,
  client?: CopilotEvidenceClient,
  now?: () => Date,
): Promise<CopilotEvidenceBundle>;
```

Implementation:

- for Kubernetes source only in Phase 1
- call `listPodsFor(namespace, kind, name, context)` for non-pod workload kinds
- for pod target, use target as a single pod summary when detail is not available
- call `listEventsFor(namespace, kind, name, context)`
- summarize readiness, pod count, restart total, highest restart pod, warning events
- build CTAs with existing `buildLogsTargetCta`, `buildEventsCta`, and a new workload route CTA

- [ ] **Step 4: Verify GREEN**

Run evidence tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/copilotEvidence.ts src/lib/copilotEvidence.test.ts src/lib/copilotNavigation.ts src/lib/copilotNavigation.test.ts
git commit -m "feat: collect native copilot evidence"
```

---

## Chunk 3: Native Response Builder

### Task 4: Async Native Copilot Responses

**Files:**
- Modify: `src/lib/copilotAssistant.ts`
- Modify: `src/lib/copilotAssistant.test.ts`
- Modify: `src/lib/copilotIntent.ts`
- Modify: `src/lib/copilotIntent.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests for:

- `fetch customer service logs` returns `mode: "resolved"` with target and evidence
- `why is customer service failing` returns evidence cards
- two matching candidates returns `mode: "ambiguous"`
- `restart customer service` returns mutation handoff text and no mutating action

- [ ] **Step 2: Verify RED**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test -- src/lib/copilotAssistant.test.ts
```

- [ ] **Step 3: Implement native response builder**

Add:

```ts
export type CopilotResponseMode = "resolved" | "ambiguous" | "not_found" | "handoff";

export type NativeCopilotResponse = CopilotResponse & {
  mode: CopilotResponseMode;
  target?: CopilotResolvedResource;
  candidates?: CopilotResolvedResource[];
  evidence?: CopilotEvidenceBundle;
};

export async function buildNativeCopilotResponse(
  input: CopilotResponseInput,
  dependencies?: {
    resolver?: CopilotResolverClient;
    evidence?: CopilotEvidenceClient;
  },
): Promise<NativeCopilotResponse>;
```

Keep `buildCopilotResponse` as a synchronous fallback for older tests and session display.

- [ ] **Step 4: Verify GREEN**

Run assistant, resolver, evidence, navigation, and intent tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/copilotAssistant.ts src/lib/copilotAssistant.test.ts src/lib/copilotIntent.ts src/lib/copilotIntent.test.ts
git commit -m "feat: build native copilot responses"
```

---

## Chunk 4: Drawer Integration

### Task 5: Render Native Responses

**Files:**
- Modify: `src/components/copilot/CopilotDrawer.tsx`
- Modify: `src/components/copilot/CopilotDrawer.test.tsx`

- [ ] **Step 1: Write failing component tests**

Mock `buildNativeCopilotResponse` or inject dependencies through a test-only prop if needed.

Test:

- resolved response shows target card and evidence facts
- ambiguous response shows candidate buttons
- selecting a candidate reruns evidence or updates selected candidate
- submit button shows loading state
- errors render without losing draft

- [ ] **Step 2: Verify RED**

Run drawer tests.

- [ ] **Step 3: Implement drawer changes**

Implementation:

- `submit` becomes async
- set `running` and `error` state
- store latest `NativeCopilotResponse` in component state
- save session after response returns
- render:
  - resolved target card
  - candidate cards for ambiguous
  - evidence fact/warning cards
  - existing CTA cards

- [ ] **Step 4: Verify GREEN**

Run drawer and assistant tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/copilot/CopilotDrawer.tsx src/components/copilot/CopilotDrawer.test.tsx
git commit -m "feat: render native copilot evidence"
```

---

## Chunk 5: Verification and PR Update

### Task 6: Full Verification

**Files:**
- Modify only if checks require baseline drift updates.

- [ ] **Step 1: Run focused tests**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test -- \
  src/lib/copilotResourceResolver.test.ts \
  src/lib/copilotEvidence.test.ts \
  src/lib/copilotAssistant.test.ts \
  src/components/copilot/CopilotDrawer.test.tsx
```

- [ ] **Step 2: Run full test suite**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test
```

- [ ] **Step 3: Run build/lint/guards**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test:design-guard
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run perf:bundle
```

- [ ] **Step 4: Push branch**

```bash
env -u GITHUB_TOKEN git push
```

- [ ] **Step 5: Confirm PR state**

```bash
env -u GITHUB_TOKEN gh pr view 66 --json url,mergeable,statusCheckRollup
```
