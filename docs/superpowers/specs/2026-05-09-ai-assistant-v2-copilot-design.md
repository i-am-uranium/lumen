# AI Assistant v2 Operator Copilot Design

## Goal

Redesign Lumen's existing AI Assistant into an operator-first Copilot experience that is always available, less cluttered, page-aware, and read-only in the first iteration.

The feature should reuse the current AI provider, prompt, structured response, safe-command, and session plumbing. It should not introduce a second AI system.

## Problem

The current AI Assistant behaves more like a generic prompt playground than an SRE/operator workflow. Too many controls are visible up front, the user has to decide what context to include, and common operational requests such as "show latest logs from customer service" or "I deployed doctor dashboard, please sync" do not guide the operator to the right Lumen surface.

This makes the assistant powerful but unintuitive during real incident or deployment work.

## Product Direction

Build **AI Assistant v2: Floating Operator Copilot**.

The Copilot is a simplified, always-available shell around the existing AI Assistant. It opens as a right-side drawer from cluster pages and focuses on:

- one natural-language input
- automatic context collection from the current route
- intent chips for common operator tasks
- structured read-only answers
- navigation CTAs to the correct Lumen page
- persistent local AI sessions

## Scope

### In Scope

- Floating "Ask Copilot" launcher across cluster workspace pages.
- Right-side Copilot drawer that can be opened and closed without losing the current session.
- Simplified prompt-first UX.
- Existing AI provider/model controls moved behind a compact settings area or reused from Settings/current Assistant internals.
- Context collection from:
  - current cluster context
  - current route
  - selected namespace
  - selected resource when available through URL or route state
  - recent alerts/change history/session metadata where available without expensive live scans
- Read-only natural-language intent recognition for common operator asks:
  - logs lookup
  - ArgoCD app lookup/sync intent
  - rollout investigation
  - incident summary/update drafting
  - resource explanation
- CTA cards that navigate to existing Lumen pages with prefilled filters where supported.
- Local session persistence using the existing AI session system.
- "New investigation" action that explicitly starts a fresh session.

### Out of Scope

- Mutating cluster actions from Copilot.
- Hidden clicks or automatic sync/restart/scale/rollback.
- Creating a new AI provider abstraction.
- Replacing the existing dedicated `/cluster/:ctx/ai` route entirely.
- Full natural-language command execution.
- Server-side session storage or team sharing.

## Operator Behavior

### Example: Logs Intent

User asks:

> show latest logs from customer service

Copilot should:

1. Interpret this as a read-only logs lookup.
2. Resolve likely targets in the current context/namespace using lightweight workload/resource matching.
3. If one likely match exists, show:
   - matched workload/resource
   - namespace
   - confidence/evidence
   - CTA: "Open logs filtered to customer-service"
   - optional CTA: "Open related events"
4. If multiple matches exist, show choices.
5. If no match exists, offer CTAs to open Logs with search text and Workloads search.

### Example: ArgoCD Sync Intent

User asks:

> I deployed the doctor dashboard, please sync

Copilot should:

1. Interpret this as an ArgoCD sync intent.
2. Search known ArgoCD app summaries for likely matches such as `doctor-dashboard`.
3. Explain that v1 is read-only.
4. Show CTA: "Open doctor-dashboard in ArgoCD".
5. Optionally show CTA: "Open rollout timeline".
6. Leave the actual sync action on the existing ArgoCD page, where preflight and confirmation already exist.

### Example: Incident Explanation

User asks:

> why is this deployment failing?

Copilot should:

1. Collect page/resource context.
2. Build an investigation prompt with redacted evidence.
3. Return structured cards:
   - summary
   - evidence
   - likely causes
   - next checks
   - read-only commands
   - navigation CTAs

## UX Design

### States

- **Closed:** only a floating "Ask Copilot" launcher is visible.
- **Open:** right-side drawer is visible, anchored over the cluster workspace.
- **Session retained:** closing the drawer hides it but preserves the latest conversation.
- **New investigation:** explicit action that clears current draft/thread and starts fresh.

### Drawer Layout

Top:

- title: "AI Ops Copilot"
- context line: current cluster, namespace, page/resource summary
- close button
- new investigation button
- compact settings button

Main:

- one prompt input
- intent chips:
  - explain this
  - find logs
  - open app
  - draft update
- response cards
- CTA cards

Footer:

- read-only badge
- provider/model status if needed

### Dedicated AI Route

The existing `/cluster/:ctx/ai` route should remain but should adopt the simplified shell. It can show a wider workspace version of the same Copilot rather than the old dense control layout.

## Architecture

### Reuse Existing Pieces

- `src/routes/cluster/AiAssistant.tsx`
  - provider/model and response pipeline
  - structured answer rendering
  - session/history integration
- `src/lib/aiSessions.ts`
  - local session persistence
- `src/lib/aiStructured.ts`
  - structured response grouping
- `src/lib/ai.ts`
  - provider invocation

### New/Changed Pieces

- `src/lib/copilotIntent.ts`
  - pure intent classification and target phrase extraction.
  - no React, no network, easy to unit test.
- `src/lib/copilotNavigation.ts`
  - builds route targets/CTA cards from recognized intents and resolved resources.
- `src/lib/copilotContext.ts`
  - summarizes current route/context and constructs prompt context.
- `src/components/copilot/CopilotDrawer.tsx`
  - drawer shell, close/new/session behavior.
- `src/components/copilot/CopilotLauncher.tsx`
  - floating button visible in cluster workspace.
- `src/components/copilot/CopilotCtaCard.tsx`
  - reusable CTA card.
- `src/state/copilotUi.ts`
  - open/closed state, current session id, drawer preferences.

### Integration Points

- `src/routes/cluster/ClusterWorkspace.tsx`
  - render floating launcher/drawer inside cluster workspace layout.
- `src/routes/cluster/AiAssistant.tsx`
  - extract reusable assistant internals where needed.
  - use the simplified Copilot layout on the dedicated AI page.
- `src/components/CommandPalette.tsx`
  - optional command: "open Copilot".

## Data Flow

1. User opens Copilot from floating launcher.
2. Drawer reads current route context.
3. User enters prompt.
4. Intent classifier runs first.
5. If intent maps to navigation, Copilot shows explanation and CTA cards.
6. If intent needs analysis, prompt builder sends redacted context through existing AI provider flow.
7. Response and CTA metadata are saved into local AI session history.
8. Closing drawer preserves session.

## Safety

- v1 is read-only.
- Copilot can navigate but cannot execute mutating commands.
- Suggested commands must be read-only.
- Any mutation intent must resolve to a CTA that opens the existing page/dialog where normal preflight and confirmation apply.
- Secret redaction must reuse existing redaction practices where available and avoid persisting raw sensitive evidence.

## Testing

- Unit tests for intent classification:
  - logs intent
  - ArgoCD sync intent
  - incident explanation
  - ambiguous/no intent
- Unit tests for CTA route construction:
  - logs URL with namespace/workload filters
  - ArgoCD app URL with app query
  - fallback search URLs
- Store tests for drawer open/close/new investigation persistence.
- Component tests for:
  - launcher appears in cluster workspace
  - drawer closes without clearing session
  - new investigation clears active draft/thread
  - read-only sync intent renders ArgoCD CTA instead of action execution
- Existing full suite, lint, build, bundle budget.

## Open Decisions

- Exact drawer width and mobile behavior.
- How much of the current `AiAssistant.tsx` should be extracted versus wrapped for v1.
- Whether selected resource context should be URL-only in v1 or include a lightweight shared selection store.
- Whether logs CTA should prefill by workload kind/name only or also infer labels.

## Acceptance Criteria

- Operator can open Copilot from any cluster workspace page.
- Operator can close and reopen the drawer without losing the current session.
- Operator can start a new investigation explicitly.
- "show latest logs from customer service" produces a logs-oriented read-only response and CTA.
- "I deployed doctor dashboard, please sync" produces an ArgoCD-oriented read-only response and CTA.
- AI Assistant page is visibly less cluttered than before.
- Existing provider/session behavior still works.
- No cluster mutation can be triggered directly from Copilot.
