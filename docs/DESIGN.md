# Lumen Design System

Lumen is an enterprise-grade, multi-cluster Kubernetes operations console. The UI must feel technical, fast, dense, calm, secure, multi-cluster first, and AI-assisted without making AI the center of every workflow.

This document is part of the public contributor contract. New screens should reuse these tokens and primitives rather than introducing local one-off styling.

## Product Direction

Lumen is built for engineers operating real infrastructure. Prioritize operational confidence over marketing polish.

Reference qualities:

- HashiCorp-style enterprise infrastructure clarity.
- Linear-style command palette polish.
- Lens-style Kubernetes resource density.
- Datadog/Grafana-style observability surfaces.

Avoid playful SaaS visuals, decorative gradients, oversized empty space, card-heavy marketing layouts, and AI-first surfaces that distract from cluster context.

## UX Principles

### Context Always Visible

Every resource screen must make these visible before any destructive or AI-assisted action:

- Active cluster
- Namespace
- Resource kind
- Resource name
- Status

### Dense But Scannable

Use compact rows, clear hierarchy, stable panel dimensions, and fixed toolbars. Use monospace text for resource names, namespaces, labels, YAML, logs, commands, and IDs.

### AI Is Contextual

GPT features belong beside logs, events, resource details, alerts, and incident summaries. Before sending infrastructure context to AI, redact secrets, tokens, kubeconfigs, and sensitive environment values. Show a context preview when possible.

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
- GPT entry as an assistive action, not the primary surface.

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
- Ask Lumen GPT with redacted context.
- Delete with confirmation.

### Logs

Required:

- Virtualized logs.
- Level filter.
- Time range selector.
- Namespace and container filters.
- Insights panel.
- GPT actions for selected line, recent summary, root cause, and incident summary.

### Settings / AI Assistant

Required:

- Account connection status.
- Connect/disconnect.
- Default model preference.
- Redaction mode.
- Context preview setting.
- Usage transparency.

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
