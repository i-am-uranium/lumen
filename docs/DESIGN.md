# Lumen Design System

Lumen is an enterprise-grade, multi-cluster Kubernetes operations console. The UI must feel technical, fast, dense, calm, secure, and multi-cluster first.

This document is part of the public contributor contract. New screens should reuse these tokens and primitives rather than introducing local one-off styling.

## Product Direction

Lumen is built for engineers operating real infrastructure. Prioritize operational confidence over marketing polish.

Reference qualities:

- HashiCorp-style enterprise infrastructure clarity.
- Linear-style command palette polish.
- Lens-style Kubernetes resource density.
- Datadog/Grafana-style observability surfaces.

Avoid playful SaaS visuals, decorative gradients, oversized empty space, card-heavy marketing layouts, and surfaces that distract from cluster context.

## UX Principles

### Context Always Visible

Every resource screen must make these visible before any destructive action:

- Active cluster
- Namespace
- Resource kind
- Resource name
- Status

### Dense But Scannable

Use compact rows, clear hierarchy, stable panel dimensions, and fixed toolbars. Use monospace text for resource names, namespaces, labels, YAML, logs, commands, and IDs.

### Evidence Is Contextual

Keep logs, events, resource details, alerts, and incident reports connected to their cluster and resource. Inspection and report export work without a model provider.

### Secure By Default

Destructive actions require clear scope and confirmation. Status must use text and color, never color alone. Logs and YAML must remain selectable.

## Tokens

Global tokens live in `src/index.css` and Tailwind mappings live in `tailwind.config.js`.

Use semantic tokens:

- Background: `bg-app`, `bg-shell`, `bg-surface`, `bg-elevated`, `bg-hover`
- Borders: `border-border-subtle`, `border-border-default`, `border-border-strong`
- Text: `text-text-primary`, `text-text-secondary`, `text-text-muted`, `text-text-disabled`
- Accent: `text-accent-primary`, `bg-accent-primary`, `bg-accent-primary-soft`
- Status: `text-success`, `text-warning`, `text-danger`, `text-info`

Do not add raw hex colors in route components. Add a token first if a new color is genuinely required.

## Typography

Interface text uses Inter. Operational text uses JetBrains Mono.

Recommended sizes:

- Sidebar labels: `text-xs`
- Table body: `text-xs` or `text-sm`
- Table headers: `text-[11px] uppercase`
- Panel titles: `text-sm` to `text-base`
- Dashboard numbers: `text-2xl`
- Logs, YAML, resource names, IDs: `font-mono text-xs`

## Layout

Desktop:

- Persistent sidebar.
- Main content surface.
- Optional right detail drawer, 420-560px.
- Top toolbar height near 56px.
- Table rows near 42-46px.
- Panel radius uses `rounded-panel`.

Responsive:

- Tablet: collapsible navigation and overlay drawer.
- Mobile: bottom navigation, stacked cards, full-screen details.
- Do not hide critical functionality on mobile; adapt it.

## Shared Primitives

Use these before creating new local UI:

- `src/components/ui/button.tsx`
- `src/components/ui/input.tsx`
- `src/components/ui/badge.tsx`
- `src/components/ui/card.tsx`
- `src/components/ui/data-table.tsx`
- `src/components/ui/status-badge.tsx`
- `src/components/lumen/page.tsx`
- `src/components/lumen/metric-card.tsx`
- `src/components/lumen/resource-name.tsx`

Route components may compose layout, data, and behavior, but repeated visual surfaces belong in `src/components/ui` or `src/components/lumen`.

## Screen Requirements

### Global Dashboard

Required:

- Cluster scope and search entry.
- Metric cards for clusters, nodes, pods, workloads, CPU, memory, alerts.
- Cluster health table.
- Top resource pressure.
- Recent alerts or signals.

### Resource Explorer

Required filters:

- Cluster
- Namespace
- Resource kind
- Status
- Labels
- Search

Use `StatusBadge`, `ResourceName`, and `DataTable` primitives.

### Resource Detail

Required tabs:

- Overview
- YAML
- Logs
- Events
- Metrics
- Related

Required actions:

- Copy resource name.
- Copy `kubectl describe` command.
- Restart rollout where applicable.
- View logs.
- Delete with confirmation.

### Logs

Required:

- Virtualized logs.
- Level filter.
- Time range selector.
- Namespace and container filters.
- Insights panel.

### Settings

Keep theme, density, read-only mode, keyboard shortcuts, and workspace preferences easy to find. Settings describe local behavior and do not require account or model setup.

## Accessibility

- Every interactive element must have a keyboard focus state.
- Use labels or accessible names for icon-only buttons.
- Drawer and modal focus must be trapped.
- Escape closes overlays.
- Color cannot be the only status indicator.
- Truncated Kubernetes names need `title` or tooltip support.

## Performance Rules

- Do not render unbounded arrays directly.
- Keep log append paths coalesced and capped.
- Use virtualization for high-volume lists.
- Avoid fleet-wide blocking calls on the UI thread.
- Treat unreachable contexts as partial failures.
- Keep route chunks within the bundle budget enforced by `npm run perf:bundle`.


### `src/components/lumen/drawer.tsx`

Resizable side-drawer primitives — compose these instead of writing raw `aside`/`div` shells.

| Export | Purpose |
|---|---|
| `DrawerBackdrop` | Fixed semi-transparent scrim (`bg-black/30`), clickable to dismiss |
| `DrawerPanel` | Fixed right-docked `<aside>` with `bg-shell border-l border-border-default shadow-[var(--shadow-popover)]`; accepts `width?: number` |
| `DrawerResizeHandle` | 4 px drag target on left edge; shows `bg-accent-primary` line on hover |
| `DrawerHeader` | `min-h-14 border-b border-border-default bg-shell` header row |
| `DrawerTabs` | `border-b border-border-default bg-elevated` tab strip container |
| `DrawerTabButton` | Tab button with `border-b-2` active indicator (`border-accent-primary`) |

**Usage:**
```tsx
import {
  DrawerBackdrop, DrawerPanel, DrawerResizeHandle,
  DrawerHeader, DrawerTabs, DrawerTabButton,
} from "@/components/lumen/drawer";

<DrawerBackdrop onClick={onClose} />
<DrawerPanel width={width} role="dialog">
  <DrawerResizeHandle onPointerDown={startResize} />
  <DrawerHeader>…</DrawerHeader>
  <DrawerTabs>
    <DrawerTabButton active={tab === "props"} onClick={() => setTab("props")}>
      properties
    </DrawerTabButton>
  </DrawerTabs>
  …
</DrawerPanel>
```

## Contributor Examples

Use these quick patterns to keep route code focused on behavior while shared primitives own visual consistency.

### Empty and Error States

```tsx
import { EmptyState, ErrorPanel } from "@/components/lumen/feedback";

if (error) {
  return <ErrorPanel title="Unable to load pods" description={error.message} />;
}

if (!pods.length) {
  return <EmptyState title="No pods found" description="Try switching namespace filters." />;
}
```

### Action Rows and Confirmation Cards

```tsx
import { CommandRow } from "@/components/lumen/command-row";
import { ConfirmActionCard } from "@/components/lumen/confirm-action-card";

<CommandRow
  label="Restart deployment"
  description="Rolls all replicas in the selected namespace."
  actions={<Button variant="danger">Restart</Button>}
/>

<ConfirmActionCard
  title="Delete workload"
  body="This removes the workload from the active cluster and namespace."
  confirmLabel="Delete workload"
/>
```

When a primitive does not exist yet, add it to `src/components/lumen` or `src/components/ui` and document usage here instead of repeating route-local style blocks.


## Design Guard Workflow

The design-system guard is baseline-driven to allow incremental cleanup without blocking unrelated work.

- Run `npm run test:design-guard` to verify no new style regressions were introduced.
- Run `npm run design-guard:refresh` only when intentionally accepting/removing legacy exceptions.
- Treat baseline updates as design-review changes: explain why each new exception is needed, or why the count went down.

This keeps enforcement strict for new drift while still allowing the codebase to migrate steadily toward tokenized styles.
