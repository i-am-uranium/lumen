# AI Assistant v2 Operator Copilot Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only, floating Operator Copilot that reuses Lumen's existing AI Assistant plumbing while making common operator intents easier to act on through navigation CTAs.

**Architecture:** Add pure intent/navigation/context helpers, a persisted Copilot UI store, and a floating drawer mounted from `ClusterWorkspace`. Keep AI provider/session behavior in the existing assistant stack and make the dedicated AI page use the same simplified interaction model where practical.

**Tech Stack:** React, React Router, Zustand, TanStack Query, Vitest, TypeScript, existing Lumen UI primitives.

---

## Files

- Create: `src/lib/copilotIntent.ts`
  - Classifies read-only operator intents and extracts target phrases.
- Create: `src/lib/copilotIntent.test.ts`
  - RED/GREEN coverage for logs, ArgoCD sync/open-app, incident/update, and unknown intents.
- Create: `src/lib/copilotNavigation.ts`
  - Builds navigation CTA cards for logs, ArgoCD, events, rollout timeline, and fallback searches.
- Create: `src/lib/copilotNavigation.test.ts`
  - Validates URL construction and read-only action metadata.
- Create: `src/lib/copilotContext.ts`
  - Converts current route/context into concise Copilot context items and prompt text.
- Create: `src/lib/copilotContext.test.ts`
  - Validates route labeling and redaction-friendly context summaries.
- Create: `src/state/copilotUi.ts`
  - Persists drawer open/closed state and current session id.
- Create: `src/state/copilotUi.test.ts`
  - Validates close preserves session and new investigation clears current session id.
- Create: `src/components/copilot/CopilotCtaCard.tsx`
  - Renders read-only navigation CTA cards.
- Create: `src/components/copilot/CopilotDrawer.tsx`
  - Floating drawer shell, prompt input, intent chips, CTA handling, session persistence handoff.
- Create: `src/components/copilot/CopilotLauncher.tsx`
  - Floating launcher button.
- Create: `src/components/copilot/CopilotDrawer.test.tsx`
  - Tests close/new/session behavior and CTA rendering.
- Modify: `src/routes/cluster/ClusterWorkspace.tsx`
  - Mount launcher and drawer once per cluster workspace.
- Modify: `src/routes/cluster/AiAssistant.tsx`
  - Reduce up-front clutter by hiding advanced controls by default and aligning quick prompts with Copilot intents.
- Modify: `src/components/CommandPalette.tsx`
  - Add "open Copilot" command.
- Modify: `src/lib/designSystemGuard.baseline.json`
  - Refresh only if line-number drift requires it.

---

## Chunk 1: Intent and Navigation Core

### Task 1: Intent Classifier

**Files:**
- Create: `src/lib/copilotIntent.test.ts`
- Create: `src/lib/copilotIntent.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { classifyCopilotIntent } from "./copilotIntent";

describe("classifyCopilotIntent", () => {
  it("classifies latest logs requests and extracts target text", () => {
    expect(classifyCopilotIntent("show latest logs from customer service")).toMatchObject({
      kind: "logs",
      targetText: "customer service",
    });
  });

  it("classifies sync requests as read-only ArgoCD navigation intents", () => {
    expect(classifyCopilotIntent("I deployed the doctor dashboard, please sync")).toMatchObject({
      kind: "argocd-app",
      targetText: "doctor dashboard",
      requestedAction: "sync",
    });
  });

  it("classifies incident update requests", () => {
    expect(classifyCopilotIntent("draft an incident update for this alert")).toMatchObject({
      kind: "incident-update",
    });
  });

  it("falls back to investigation for unknown questions", () => {
    expect(classifyCopilotIntent("why is this failing")).toMatchObject({
      kind: "investigate",
    });
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test -- src/lib/copilotIntent.test.ts`

Expected: fails because `src/lib/copilotIntent.ts` does not exist.

- [ ] **Step 3: Implement minimal classifier**

Implement exported types and `classifyCopilotIntent(prompt: string)`.

- [ ] **Step 4: Verify GREEN**

Run the focused test again. Expected: all intent tests pass.

### Task 2: Navigation CTA Builder

**Files:**
- Create: `src/lib/copilotNavigation.test.ts`
- Create: `src/lib/copilotNavigation.ts`

- [ ] **Step 1: Write failing tests**

Cover:
- logs CTA: `/cluster/<ctx>/logs?ns=<ns>&kind=deployment&name=<name>`
- ArgoCD CTA: `/cluster/<ctx>/argocd?app=<namespace>/<name>`
- fallback logs search with `grep`
- CTA metadata remains read-only.

- [ ] **Step 2: Verify RED**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test -- src/lib/copilotNavigation.test.ts`

- [ ] **Step 3: Implement route builders**

Create `CopilotCta` type and pure builder functions.

- [ ] **Step 4: Verify GREEN**

Run focused navigation tests.

---

## Chunk 2: Context and UI State

### Task 3: Copilot Context Builder

**Files:**
- Create: `src/lib/copilotContext.test.ts`
- Create: `src/lib/copilotContext.ts`

- [ ] **Step 1: Write failing tests**

Test route summaries for logs, alerts, ArgoCD, resource-ish routes, and generic cluster pages.

- [ ] **Step 2: Verify RED**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test -- src/lib/copilotContext.test.ts`

- [ ] **Step 3: Implement context summary helpers**

Export `buildCopilotRouteContext` and `buildCopilotPromptContext`.

- [ ] **Step 4: Verify GREEN**

Run focused context tests.

### Task 4: Copilot UI Store

**Files:**
- Create: `src/state/copilotUi.test.ts`
- Create: `src/state/copilotUi.ts`

- [ ] **Step 1: Write failing tests**

Test:
- `open()` sets open true.
- `close()` sets open false and keeps `activeSessionId`.
- `startNewInvestigation()` clears `activeSessionId`.
- persisted state loads safely.

- [ ] **Step 2: Verify RED**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test -- src/state/copilotUi.test.ts`

- [ ] **Step 3: Implement Zustand store**

Use localStorage with best-effort reads/writes following existing store patterns.

- [ ] **Step 4: Verify GREEN**

Run focused store tests.

---

## Chunk 3: Floating Copilot Shell

### Task 5: Drawer Components

**Files:**
- Create: `src/components/copilot/CopilotCtaCard.tsx`
- Create: `src/components/copilot/CopilotLauncher.tsx`
- Create: `src/components/copilot/CopilotDrawer.tsx`
- Create: `src/components/copilot/CopilotDrawer.test.tsx`

- [ ] **Step 1: Write failing component tests**

Test:
- launcher opens drawer.
- close hides drawer without clearing session id.
- sync intent renders ArgoCD CTA and no mutating execution button.
- logs intent renders Logs CTA.
- new investigation clears prompt/session state.

- [ ] **Step 2: Verify RED**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test -- src/components/copilot/CopilotDrawer.test.tsx`

- [ ] **Step 3: Implement components**

Implement a lightweight drawer with prompt input, four intent chips, read-only badge, close/new buttons, response/CTA cards.

- [ ] **Step 4: Verify GREEN**

Run focused component tests.

### Task 6: Cluster Workspace Integration

**Files:**
- Modify: `src/routes/cluster/ClusterWorkspace.tsx`
- Modify: `src/components/CommandPalette.tsx`

- [ ] **Step 1: Add failing integration expectation**

Extend an existing workspace/palette test or add a focused test that verifies:
- cluster workspace renders "Ask Copilot"
- command palette has "open Copilot"

- [ ] **Step 2: Verify RED**

Run the focused tests.

- [ ] **Step 3: Mount launcher/drawer and command**

Render the Copilot shell inside `ClusterWorkspace` and wire command palette to `useCopilotUi.getState().open()`.

- [ ] **Step 4: Verify GREEN**

Run the focused tests.

---

## Chunk 4: Simplify Dedicated AI Page

### Task 7: Reduce Visible Moving Parts

**Files:**
- Modify: `src/routes/cluster/AiAssistant.tsx`
- Update or add tests if an existing AI Assistant test file is present.

- [ ] **Step 1: Inspect existing tests**

Run: `rg -n "AiAssistant" src -g '*.test.tsx'`

- [ ] **Step 2: Write or update tests**

Assert that advanced settings are collapsed by default and quick intent chips are visible.

- [ ] **Step 3: Implement minimal page cleanup**

Keep provider/model settings available but move them behind the existing details/settings affordance. Keep existing behavior intact.

- [ ] **Step 4: Verify focused tests**

Run the relevant focused tests.

---

## Chunk 5: Final Verification and PR

- [ ] **Run focused new tests**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test -- \
  src/lib/copilotIntent.test.ts \
  src/lib/copilotNavigation.test.ts \
  src/lib/copilotContext.test.ts \
  src/state/copilotUi.test.ts \
  src/components/copilot/CopilotDrawer.test.tsx
```

- [ ] **Run full frontend checks**

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run test
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run lint
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run build
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run perf:bundle
```

- [ ] **Run Rust checks if no Rust touched**

Skip Rust checks if only frontend files changed. If Tauri/Rust files are touched, run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

- [ ] **Commit implementation**

```bash
git add <changed-files>
git commit -m "feat: add floating AI ops copilot"
```

- [ ] **Push and open PR**

```bash
env -u GITHUB_TOKEN git push -u origin codex/ai-assistant-v2-copilot
env -u GITHUB_TOKEN gh pr create --base main --head codex/ai-assistant-v2-copilot
```
