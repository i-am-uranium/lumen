import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFocusSearch } from "@/lib/focusSearch";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Box,
  CheckCircle2,
  Filter,
  Layers3,
  RefreshCw,
  Search,
  Server,
  Trash2,
  RotateCw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { k8s, type WorkloadKind, type WorkloadSummary } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { useK8sWatch } from "@/hooks/useK8sWatch";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { ResourceDetailDrawer } from "@/components/ResourceDetailDrawer";
import { useRecentResources } from "@/hooks/useRecentResources";
import { RESOURCE_KIND_BY_SLUG, listResourceDefinitions, resourceKindLabel } from "@/lib/k8s/resourceRegistry";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DataTableShell,
} from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { LumenPage, PageHeader, SectionPanel, ToolbarSurface } from "@/components/lumen/page";
import { MetricCard, type MetricTone } from "@/components/lumen/metric-card";
import { Star } from "lucide-react";
import { ColumnPicker } from "@/components/ColumnPicker";
import { NamespacePicker } from "@/components/NamespacePicker";
import { AutoRefreshPicker } from "@/components/AutoRefreshPicker";
import { applyColumnLayout, useUiSettings } from "@/state/uiSettings";
import { usePinnedResources } from "@/hooks/usePinnedResources";
import { PreflightPreviewDialog } from "@/components/PreflightPreviewDialog";
import {
  buildActionPreflight,
  parseReadyReplicas,
  type PreflightTarget,
} from "@/lib/preflight";

// ─── URL slug ↔ WorkloadKind ──────────────────────────────────────────────

const SLUG_TO_KIND = RESOURCE_KIND_BY_SLUG;

const ALL_KINDS: WorkloadKind[] = [
  ...listResourceDefinitions({ category: "workloads" })
    .filter((definition) =>
      ["pod", "deployment", "statefulset", "daemonset", "job", "cronjob"].includes(
        definition.kind,
      ),
    )
    .map((definition) => definition.kind),
];

// ─── helpers ──────────────────────────────────────────────────────────────

function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function formatBytes(n: number): string {
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function statusColor(phase: string | undefined): string {
  switch (phase) {
    case "Running":
    case "Succeeded":
      return "text-success";
    case "Pending":
      return "text-warning";
    case "Failed":
      return "text-danger";
    default:
      return "text-text-secondary";
  }
}

function formatCpu(milli: number): string {
  if (milli >= 1000) return `${(milli / 1000).toFixed(milli >= 10_000 ? 0 : 2)}`;
  return `${Math.round(milli)}m`;
}

export type QuickFilter = "unhealthy" | "restarts" | "pending" | "failed";
export type WorkloadSortKey =
  | "namespace"
  | "name"
  | "kind"
  | "ready"
  | "health"
  | "status"
  | "age"
  | "restarts"
  | "cpu"
  | "memory"
  | "containers"
  | "node"
  | "qos";
export type WorkloadSortDirection = "asc" | "desc";
export type WorkloadSort = {
  key: WorkloadSortKey;
  direction: WorkloadSortDirection;
};

export function workloadRiskScore(w: WorkloadSummary): number {
  if (w.health === "failed") return 0;
  if (w.health === "degraded") return 1;
  if ((w.restart_count ?? 0) > 0) return 2;
  if (
    w.kind === "pod" &&
    w.pod_phase &&
    !["Running", "Succeeded"].includes(w.pod_phase)
  ) {
    return 3;
  }
  if (w.age_seconds < 600) return 4;
  return 5;
}

function compareText(a: string | undefined, b: string | undefined): number {
  return (a ?? "").localeCompare(b ?? "");
}

function compareNumbers(
  a: number | undefined,
  b: number | undefined,
  direction: WorkloadSortDirection = "asc",
): number {
  const aMissing = a === undefined || !Number.isFinite(a);
  const bMissing = b === undefined || !Number.isFinite(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return direction === "desc" ? b - a : a - b;
}

function defaultWorkloadCompare(a: WorkloadSummary, b: WorkloadSummary): number {
  const risk = workloadRiskScore(a) - workloadRiskScore(b);
  if (risk !== 0) return risk;
  if (a.namespace !== b.namespace) return a.namespace.localeCompare(b.namespace);
  if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
  return a.name.localeCompare(b.name);
}

function compareBySortKey(
  a: WorkloadSummary,
  b: WorkloadSummary,
  sort: WorkloadSort,
): number {
  const { key, direction } = sort;
  switch (key) {
    case "namespace":
      return compareText(a.namespace, b.namespace) || compareText(a.name, b.name);
    case "name":
      return compareText(a.name, b.name);
    case "kind":
      return compareText(a.kind, b.kind) || compareText(a.namespace, b.namespace) || compareText(a.name, b.name);
    case "ready":
      return compareText(a.ready, b.ready) || compareText(a.name, b.name);
    case "health":
      return compareText(a.health, b.health) || compareText(a.name, b.name);
    case "status":
      return compareText(a.pod_phase, b.pod_phase) || compareText(a.name, b.name);
    case "age":
      return compareNumbers(a.age_seconds, b.age_seconds, direction) || compareText(a.name, b.name);
    case "restarts":
      return compareNumbers(a.restart_count ?? 0, b.restart_count ?? 0, direction) || compareText(a.name, b.name);
    case "cpu":
      return compareNumbers(a.cpu_milli, b.cpu_milli, direction) || compareText(a.name, b.name);
    case "memory":
      return compareNumbers(a.mem_bytes, b.mem_bytes, direction) || compareText(a.name, b.name);
    case "containers":
      return compareNumbers(a.container_count, b.container_count, direction) || compareText(a.name, b.name);
    case "node":
      return compareText(a.node_name, b.node_name) || compareText(a.name, b.name);
    case "qos":
      return compareText(a.qos_class, b.qos_class) || compareText(a.name, b.name);
  }
}

export function sortWorkloads(
  rows: WorkloadSummary[],
  sort: WorkloadSort | null,
): WorkloadSummary[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const compared = sort
        ? compareBySortKey(a.row, b.row, sort)
        : defaultWorkloadCompare(a.row, b.row);
      const directed =
        sort && !["age", "restarts", "cpu", "memory", "containers"].includes(sort.key)
          ? sort.direction === "desc"
            ? -compared
            : compared
          : compared;
      return directed || a.index - b.index;
    })
    .map((item) => item.row);
}

export function workloadSelectionKey(w: Pick<WorkloadSummary, "kind" | "namespace" | "name">): string {
  return `${w.kind}/${w.namespace}/${w.name}`;
}

export function selectVisibleWorkloadKeys(rows: WorkloadSummary[]): Set<string> {
  return new Set(rows.map(workloadSelectionKey));
}

export function restartEligibleWorkloads(rows: WorkloadSummary[]): WorkloadSummary[] {
  return rows.filter((w) =>
    w.kind === "deployment" || w.kind === "statefulset" || w.kind === "daemonset",
  );
}

export function matchQuickFilters(
  w: WorkloadSummary,
  filters: Set<QuickFilter>,
): boolean {
  if (filters.has("unhealthy") && w.health === "healthy") return false;
  if (filters.has("restarts") && (w.restart_count ?? 0) <= 0) return false;
  if (filters.has("pending") && w.pod_phase !== "Pending") return false;
  if (filters.has("failed") && w.health !== "failed" && w.pod_phase !== "Failed") {
    return false;
  }
  return true;
}

function severityBg(w: WorkloadSummary): string {
  if (w.health === "failed" || w.pod_phase === "Failed") return "bg-term-red";
  if (
    w.health === "degraded" ||
    w.pod_phase === "Pending" ||
    (w.restart_count ?? 0) > 0
  ) {
    return "bg-warning";
  }
  if (w.health === "healthy" || w.pod_phase === "Running") return "bg-success";
  return "bg-term-border-soft";
}

// ─── Filter DSL parser ────────────────────────────────────────────────────
//
// Lumen-distinct: search box accepts a tiny query language. Tokens are
// space-separated; each token is either bare (name/namespace match) or
// a key:value pair. Numeric ops > / >= / < / <= / = are supported on
// restarts. All tokens AND-combine.

type Token =
  | { kind: "bare"; v: string }
  | { kind: "kv"; key: string; op: "eq" | "contains"; v: string }
  | { kind: "num"; key: string; op: "gt" | "gte" | "lt" | "lte" | "eq"; n: number };

function parseFilterTokens(input: string): Token[] {
  const out: Token[] = [];
  for (const raw of input.trim().split(/\s+/)) {
    if (!raw) continue;
    const colon = raw.indexOf(":");
    if (colon <= 0) {
      out.push({ kind: "bare", v: raw.toLowerCase() });
      continue;
    }
    const key = raw.slice(0, colon).toLowerCase();
    const valRaw = raw.slice(colon + 1);
    // Numeric ops: restarts:>0 / restarts:>=5 / etc.
    const numMatch = valRaw.match(/^(>=|<=|>|<|=)?(-?\d+(?:\.\d+)?)$/);
    if (numMatch && (key === "restarts" || key === "containers")) {
      const opStr = numMatch[1] ?? "=";
      const n = parseFloat(numMatch[2]);
      const opMap: Record<string, "gt" | "gte" | "lt" | "lte" | "eq"> = {
        ">": "gt",
        ">=": "gte",
        "<": "lt",
        "<=": "lte",
        "=": "eq",
      };
      out.push({ kind: "num", key, op: opMap[opStr], n });
      continue;
    }
    // Exact-match keys vs substring-match keys.
    const exact = new Set(["kind", "qos", "status"]);
    out.push({
      kind: "kv",
      key,
      op: exact.has(key) ? "eq" : "contains",
      v: valRaw.toLowerCase(),
    });
  }
  return out;
}

function matchToken(w: WorkloadSummary, t: Token): boolean {
  if (t.kind === "bare") {
    return (
      w.name.toLowerCase().includes(t.v) ||
      w.namespace.toLowerCase().includes(t.v)
    );
  }
  if (t.kind === "num") {
    const n =
      t.key === "restarts"
        ? (w.restart_count ?? 0)
        : t.key === "containers"
          ? (w.container_count ?? 0)
          : NaN;
    if (Number.isNaN(n)) return false;
    switch (t.op) {
      case "gt":
        return n > t.n;
      case "gte":
        return n >= t.n;
      case "lt":
        return n < t.n;
      case "lte":
        return n <= t.n;
      case "eq":
        return n === t.n;
    }
  }
  // kv
  const fieldVal = (() => {
    switch (t.key) {
      case "ns":
      case "namespace":
        return w.namespace.toLowerCase();
      case "name":
        return w.name.toLowerCase();
      case "kind":
        return w.kind.toLowerCase();
      case "node":
        return (w.node_name ?? "").toLowerCase();
      case "qos":
        return (w.qos_class ?? "").toLowerCase();
      case "status":
        return (w.pod_phase ?? "").toLowerCase();
      case "health":
        return w.health.toLowerCase();
      default:
        return null;
    }
  })();
  if (fieldVal === null) {
    // Unknown key → treat the whole token as bare so users don't get
    // empty results from typos.
    const raw = `${t.key}:${t.v}`.toLowerCase();
    return (
      w.name.toLowerCase().includes(raw) ||
      w.namespace.toLowerCase().includes(raw)
    );
  }
  return t.op === "eq" ? fieldVal === t.v : fieldVal.includes(t.v);
}

function qosClass(qos: string | undefined): string {
  switch (qos) {
    case "Guaranteed":
      return "text-success border-success/40 bg-success-soft";
    case "Burstable":
      return "text-term-muted border-term-border-soft bg-term-panel-2";
    case "BestEffort":
      return "text-term-subtle border-term-border-soft";
    default:
      return "text-term-subtle";
  }
}

function ExplorerMetric({
  icon,
  label,
  value,
  sub,
  tone = "muted",
  onClick,
  active,
  actionLabel,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  tone?: "good" | "warn" | "bad" | "info" | "muted";
  onClick?: () => void;
  active?: boolean;
  actionLabel?: string;
}) {
  const mappedTone: MetricTone =
    tone === "good"
      ? "success"
      : tone === "warn"
        ? "warning"
        : tone === "bad"
          ? "error"
          : tone === "muted"
            ? "muted"
            : "info";
  return (
    <MetricCard
      icon={icon}
      label={label}
      value={value}
      helper={sub}
      tone={mappedTone}
      onClick={onClick}
      active={active}
      actionLabel={actionLabel}
    />
  );
}

function ResourceKindNav({
  activeKind,
  onSelect,
}: {
  activeKind: WorkloadKind | null;
  onSelect: (kind: WorkloadKind | null) => void;
}) {
  const navKinds: Array<{ kind: WorkloadKind | null; label: string }> = [
    { kind: null, label: "All" },
    { kind: "pod", label: "Pods" },
    { kind: "deployment", label: "Deployments" },
    { kind: "statefulset", label: "StatefulSets" },
    { kind: "daemonset", label: "DaemonSets" },
    { kind: "job", label: "Jobs" },
    { kind: "cronjob", label: "CronJobs" },
  ];
  return (
    <ToolbarSurface className="flex items-center gap-1 overflow-x-auto">
      {navKinds.map((item) => {
        const active = activeKind === item.kind;
        return (
          <button
            type="button"
            key={item.label}
            onClick={() => onSelect(item.kind)}
            className={cn(
              "whitespace-nowrap rounded px-2.5 py-1.5 text-[12px] font-medium transition",
              active
                ? "bg-accent-primary-soft text-text-primary"
                : "text-text-secondary hover:bg-hover hover:text-text-primary",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </ToolbarSurface>
  );
}

// ─── Column descriptors ──────────────────────────────────────────────────
//
// Each row is rendered by mapping over a descriptor list, filtered by
// the user's `hiddenColumns` setting (see ColumnPicker). `alwaysOn`
// columns can't be hidden — `name` is the row anchor and would leave
// rows visually un-keyable if removed.
//
// `key` is stable across renames (used for persistence), `label` is the
// header text, `cell` returns the JSX for one row.

type WorkloadColumn = {
  key: string;
  label: string;
  sortKey?: WorkloadSortKey;
  alwaysOn?: boolean;
  cell: (w: WorkloadSummary) => React.ReactNode;
};

const OTHER_COLUMNS: WorkloadColumn[] = [
  {
    key: "name",
    label: "name",
    sortKey: "name",
    alwaysOn: true,
    cell: (w) => (
      <DataTableCell className="px-4">
        <span className="text-[13px] font-medium text-text-primary">
          {w.name}
        </span>
      </DataTableCell>
    ),
  },
  {
    key: "namespace",
    label: "namespace",
    sortKey: "namespace",
    cell: (w) => (
      <DataTableCell mono className="text-[11px]">
        {w.namespace}
      </DataTableCell>
    ),
  },
  {
    key: "kind",
    label: "kind",
    sortKey: "kind",
    cell: (w) => (
      <DataTableCell>
        <span className="rounded border border-border-default bg-elevated px-1.5 py-0.5 text-[10px] lowercase text-text-secondary">
          {w.kind}
        </span>
      </DataTableCell>
    ),
  },
  {
    key: "ready",
    label: "ready",
    sortKey: "ready",
    cell: (w) => (
      <DataTableCell mono className="text-[11px] tabular-nums">
        {w.ready || "—"}
      </DataTableCell>
    ),
  },
  {
    key: "health",
    label: "health",
    sortKey: "health",
    cell: (w) => (
      <DataTableCell>
        <StatusBadge status={w.health} />
      </DataTableCell>
    ),
  },
  {
    key: "age",
    label: "age",
    sortKey: "age",
    cell: (w) => (
      <DataTableCell className="text-[11px] tabular-nums">
        {formatAge(w.age_seconds)}
      </DataTableCell>
    ),
  },
];

const POD_COLUMNS: WorkloadColumn[] = [
  {
    key: "name",
    label: "name",
    sortKey: "name",
    alwaysOn: true,
    cell: (w) => (
      <DataTableCell className="max-w-[260px] px-4">
        <span className="block truncate font-mono text-[13px] font-medium text-text-primary">
          {w.name}
        </span>
      </DataTableCell>
    ),
  },
  {
    key: "namespace",
    label: "namespace",
    sortKey: "namespace",
    cell: (w) => (
      <DataTableCell mono className="text-[11px]">
        {w.namespace}
      </DataTableCell>
    ),
  },
  {
    key: "containers",
    label: "containers",
    sortKey: "containers",
    cell: (w) => (
      <DataTableCell>
        <ContainerChiclets
          ready={w.container_ready_count ?? 0}
          total={w.container_count ?? 0}
        />
      </DataTableCell>
    ),
  },
  {
    key: "cpu",
    label: "cpu",
    sortKey: "cpu",
    cell: (w) => (
      <DataTableCell mono className="text-[11px] tabular-nums">
        {w.cpu_milli !== undefined ? formatCpu(w.cpu_milli) : "—"}
      </DataTableCell>
    ),
  },
  {
    key: "memory",
    label: "memory",
    sortKey: "memory",
    cell: (w) => (
      <DataTableCell mono className="text-[11px] tabular-nums">
        {w.mem_bytes !== undefined ? formatBytes(w.mem_bytes) : "—"}
      </DataTableCell>
    ),
  },
  {
    key: "restarts",
    label: "restarts",
    sortKey: "restarts",
    cell: (w) => {
      const restarts = w.restart_count ?? 0;
      return (
        <DataTableCell
          mono
          className={cn(
            "text-[11px] tabular-nums",
            restarts > 0 ? "text-warning" : "text-text-secondary",
          )}
        >
          {restarts}
        </DataTableCell>
      );
    },
  },
  {
    key: "controlled-by",
    label: "controlled by",
    cell: (w) => (
      <DataTableCell mono className="max-w-[160px] truncate text-[11px]">
        {w.controlled_by
          ? `${w.controlled_by.kind} ${w.controlled_by.name}`
          : "—"}
      </DataTableCell>
    ),
  },
  {
    key: "node",
    label: "node",
    sortKey: "node",
    cell: (w) => (
      <DataTableCell mono className="max-w-[200px] truncate text-[11px]">
        {w.node_name ?? "—"}
      </DataTableCell>
    ),
  },
  {
    key: "qos",
    label: "qos",
    sortKey: "qos",
    cell: (w) => (
      <DataTableCell>
        {w.qos_class ? (
          <span
            className={cn(
              "inline-flex px-1.5 py-0.5 rounded text-[10px] border",
              qosClass(w.qos_class),
            )}
          >
            {w.qos_class}
          </span>
        ) : (
          <span className="text-[10px] text-term-subtle">—</span>
        )}
      </DataTableCell>
    ),
  },
  {
    key: "status",
    label: "status",
    sortKey: "status",
    cell: (w) => (
      <DataTableCell className={cn("text-[11px]", statusColor(w.pod_phase))}>
        {w.pod_phase ?? "—"}
      </DataTableCell>
    ),
  },
  {
    key: "age",
    label: "age",
    sortKey: "age",
    cell: (w) => (
      <DataTableCell className="text-[11px] tabular-nums">
        {formatAge(w.age_seconds)}
      </DataTableCell>
    ),
  },
];

function laidOutColumns(
  columns: WorkloadColumn[],
  order: string[],
  hidden: string[],
): WorkloadColumn[] {
  return applyColumnLayout(columns, order, hidden);
}

// ─── Generic row (non-pod kinds) ──────────────────────────────────────────

const Row = memo(function Row({
  w,
  columns,
  selected,
  favorited,
  onToggleSelected,
  onToggleFavorite,
  onClick,
}: {
  w: WorkloadSummary;
  columns: WorkloadColumn[];
  selected: boolean;
  favorited: boolean;
  onToggleSelected: (w: WorkloadSummary) => void;
  onToggleFavorite: (w: WorkloadSummary) => void;
  onClick: (w: WorkloadSummary) => void;
}) {
  return (
    <DataTableRow
      className={cn("group cursor-pointer", selected && "bg-accent-primary-soft/40")}
      data-selected={selected}
      onClick={() => onClick(w)}
    >
      <DataTableCell
        className={cn("w-1 p-0", severityBg(w))}
        aria-hidden="true"
      />
      <SelectionCell
        w={w}
        selected={selected}
        onToggle={onToggleSelected}
      />
      <FavoriteCell
        w={w}
        favorited={favorited}
        onToggle={onToggleFavorite}
      />
      {columns.map((c) => (
        <React.Fragment key={c.key}>{c.cell(w)}</React.Fragment>
      ))}
    </DataTableRow>
  );
});

// ─── Pod-specific row (Lens-style enrichment, Lumen aesthetic) ────────────

const PodRow = memo(function PodRow({
  w,
  columns,
  selected,
  favorited,
  onToggleSelected,
  onToggleFavorite,
  onClick,
}: {
  w: WorkloadSummary;
  columns: WorkloadColumn[];
  selected: boolean;
  favorited: boolean;
  onToggleSelected: (w: WorkloadSummary) => void;
  onToggleFavorite: (w: WorkloadSummary) => void;
  onClick: (w: WorkloadSummary) => void;
}) {
  return (
    <DataTableRow
      className={cn("group cursor-pointer", selected && "bg-accent-primary-soft/40")}
      data-selected={selected}
      onClick={() => onClick(w)}
    >
      <DataTableCell
        className={cn("w-1 p-0", severityBg(w))}
        aria-hidden="true"
      />
      <SelectionCell
        w={w}
        selected={selected}
        onToggle={onToggleSelected}
      />
      <FavoriteCell
        w={w}
        favorited={favorited}
        onToggle={onToggleFavorite}
      />
      {columns.map((c) => (
        <React.Fragment key={c.key}>{c.cell(w)}</React.Fragment>
      ))}
    </DataTableRow>
  );
});

function SelectionCell({
  w,
  selected,
  onToggle,
}: {
  w: WorkloadSummary;
  selected: boolean;
  onToggle: (w: WorkloadSummary) => void;
}) {
  const label = selected
    ? `Deselect ${w.kind}/${w.name}`
    : `Select ${w.kind}/${w.name}`;
  return (
    <DataTableCell className="w-8 px-2">
      <input
        type="checkbox"
        checked={selected}
        aria-label={label}
        title={label}
        onChange={() => onToggle(w)}
        onClick={(e) => e.stopPropagation()}
        className="size-4 rounded border-border-default bg-elevated accent-[var(--accent-primary)]"
      />
    </DataTableCell>
  );
}

// Star cell — left of the row's first user column. Always reserves
// space (so the column width is stable) but the icon only fades in on
// row hover when not favorited; favorited rows show the filled star
// permanently as a status anchor.
function FavoriteCell({
  w,
  favorited,
  onToggle,
}: {
  w: WorkloadSummary;
  favorited: boolean;
  onToggle: (w: WorkloadSummary) => void;
}) {
  const label = favorited
    ? `Unfavorite ${w.kind}/${w.name}`
    : `Favorite ${w.kind}/${w.name}`;
  return (
    <DataTableCell className="w-7 px-1">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggle(w);
        }}
        aria-label={label}
        aria-pressed={favorited}
        title={label}
        className={cn(
          "inline-flex size-5 items-center justify-center rounded transition-opacity",
          favorited
            ? "text-term-amber opacity-100"
            : "text-text-muted opacity-0 group-hover:opacity-100 hover:text-term-amber",
        )}
      >
        <Star
          className={cn("size-3.5", favorited && "fill-current")}
          aria-hidden="true"
        />
      </button>
    </DataTableCell>
  );
}

// Lumen-distinct: tiny chiclet row showing each container as a colored
// square. More information-dense than Lens's "x/y" string at a glance.
function ContainerChiclets({ ready, total }: { ready: number; total: number }) {
  if (total === 0) {
    return <span className="text-[10px] text-term-subtle">—</span>;
  }
  const visible = Math.min(total, 8);
  const overflow = total - visible;
  return (
    <div className="inline-flex items-center gap-0.5">
      {Array.from({ length: visible }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "size-2 rounded-sm",
            i < ready ? "bg-success" : "bg-term-red/70",
          )}
        />
      ))}
      {overflow > 0 && (
        <span className="ml-1 text-[10px] text-term-subtle font-mono tabular-nums">
          +{overflow}
        </span>
      )}
      <span className="ml-1.5 text-[10px] text-term-subtle font-mono tabular-nums">
        {ready}/{total}
      </span>
    </div>
  );
}

const QUICK_FILTERS: Array<{ id: QuickFilter; label: string }> = [
  { id: "unhealthy", label: "unhealthy" },
  { id: "restarts", label: "restarts > 0" },
  { id: "pending", label: "pending" },
  { id: "failed", label: "failed" },
];

function SkeletonRows({
  isPodView,
  columnCount,
}: {
  isPodView: boolean;
  columnCount: number;
}) {
  // +1 for the severity strip, +1 for selection, +1 for favorites.
  const total = columnCount + 3;
  return (
    <DataTableShell>
      <DataTable className={cn(isPodView && "min-w-[1100px]")}>
        <DataTableHeader>
          <DataTableRow>
            {Array.from({ length: total }).map((_, i) => (
              <Th key={i}>{i === 0 ? "" : " "}</Th>
            ))}
          </DataTableRow>
        </DataTableHeader>
        <DataTableBody>
          {Array.from({ length: 8 }).map((_, row) => (
            <DataTableRow key={row}>
              {Array.from({ length: total }).map((_, col) => (
                <DataTableCell key={col}>
                  <div className="h-3 animate-pulse rounded bg-elevated" />
                </DataTableCell>
              ))}
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </DataTableShell>
  );
}

// ─── view ─────────────────────────────────────────────────────────────────

export function WorkloadsView() {
  const { ctx = "", kind: kindSlug } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const context = decodeURIComponent(ctx);

  const filterKind: WorkloadKind | null = kindSlug
    ? SLUG_TO_KIND[kindSlug] ?? null
    : null;
  const isPodView = filterKind === "pod";

  // Column visibility + order — D10 + D10 finish. Watching only this
  // view's slot keeps the store subscription scoped; flipping a
  // checkbox doesn't re-render anything outside this route.
  const podHidden = useUiSettings((s) => s.hiddenColumns["workloads-pod"]);
  const otherHidden = useUiSettings((s) => s.hiddenColumns["workloads-other"]);
  const podOrder = useUiSettings((s) => s.columnOrder["workloads-pod"]);
  const otherOrder = useUiSettings((s) => s.columnOrder["workloads-other"]);
  const readOnly = useUiSettings((s) => s.readOnly);
  const podVisible = useMemo(
    () => laidOutColumns(POD_COLUMNS, podOrder, podHidden),
    [podOrder, podHidden],
  );
  const otherVisible = useMemo(
    () => laidOutColumns(OTHER_COLUMNS, otherOrder, otherHidden),
    [otherOrder, otherHidden],
  );

  const kindsToFetch = filterKind ? [filterKind] : ALL_KINDS;

  // Cmd-K resource jump lands here with ?q=name&ns=namespace pre-set so
  // the user sees the row they picked, already highlighted. URL wins
  // over persisted state so deep links land deterministically; the
  // persisted value is the fallback for plain navigation back to this
  // section.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedNamespace = searchParams.has("ns") ? searchParams.get("ns") : null;
  const namespaceScope = useNamespaceScope(context, requestedNamespace);
  const { namespace, namespaces, discoveryError, isLoading: isNamespaceLoading } = namespaceScope;
  const [search, setSearch] = useState<string>(
    () => searchParams.get("q") ?? "",
  );
  const lastSyncedSearchParams = useRef(searchParams.toString());
  const applyingUrlSearchParams = useRef(false);
  useEffect(() => {
    const current = searchParams.toString();
    if (current === lastSyncedSearchParams.current) return;
    const nextSearch = searchParams.get("q") ?? "";
    applyingUrlSearchParams.current = true;
    setSearch(nextSearch);
    lastSyncedSearchParams.current = current;
  }, [searchParams]);
  useEffect(() => {
    if (applyingUrlSearchParams.current) {
      applyingUrlSearchParams.current = false;
      return;
    }
    const next = new URLSearchParams();
    // Retired assistant tabs can contain saved operator text and a reference
    // to local evidence. Keep those values inert when normalizing filters.
    for (const key of ["question", "task", "aiContext", "kind", "name", "namespace"]) {
      for (const value of searchParams.getAll(key)) next.append(key, value);
    }
    if (!isNamespaceLoading) next.set("ns", namespace);
    if (search) next.set("q", search);
    const nextString = next.toString();
    if (nextString === searchParams.toString()) return;
    lastSyncedSearchParams.current = nextString;
    setSearchParams(next, { replace: true });
  }, [isNamespaceLoading, namespace, search, searchParams, setSearchParams]);
  const setNamespace = useCallback((next: string) => {
    namespaceScope.setNamespace(next);
    const params = new URLSearchParams(searchParams);
    params.set("ns", next);
    setSearchParams(params, { replace: true });
  }, [namespaceScope, searchParams, setSearchParams]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Cmd+/ broadcasts a focus-search event; the workloads view picks it up
  // and selects the toolbar's filter input. Ref-based so the keybinding
  // never has to know which view is mounted — see lib/focusSearch.ts.
  const onFocusSearch = useCallback(() => {
    const el = searchInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  useFocusSearch(onFocusSearch);
  const [quickFilters, setQuickFilters] = useState<Set<QuickFilter>>(
    () => new Set(),
  );
  const [sort, setSort] = useState<WorkloadSort | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [pendingBulkAction, setPendingBulkAction] = useState<"delete" | "restart" | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const autoRefreshSeconds = useUiSettings((s) => s.workloadsAutoRefreshSeconds);
  const setAutoRefreshSeconds = useUiSettings((s) => s.setWorkloadsAutoRefreshSeconds);
  const refetchInterval = autoRefreshSeconds ? autoRefreshSeconds * 1000 : false;

  const queries = useQueries({
    queries: kindsToFetch.map((k) => ({
      queryKey: ["k8s", "workloads", context, namespace, k] as const,
      queryFn: () => k8s.listWorkloads(namespace, k, context || undefined),
      enabled: !isNamespaceLoading,
      staleTime: 5_000,
      refetchInterval,
      refetchIntervalInBackground: false,
    })),
  });

  const queryKeysForWatch = useMemo(
    () => kindsToFetch.map((k) => ["k8s", "workloads", context, namespace, k]),
    [kindsToFetch, context, namespace],
  );

  useK8sWatch<WorkloadSummary>({
    queryKeys: queryKeysForWatch,
    command: "watch_workloads",
    args: {
      namespace: namespace || undefined,
      context: context || undefined,
    },
    enabled: !isNamespaceLoading,
  });

  const isLoading = isNamespaceLoading || queries.some((q) => q.isLoading);
  const isFetching = queries.some((q) => q.isFetching);
  const failedQueries = queries.filter((q) => q.error);
  const successfulQueries = queries.filter((q) => q.isSuccess);
  const firstError = failedQueries[0]?.error as Error | undefined;
  const isPartial = failedQueries.length > 0 && successfulQueries.length > 0;
  const totalError = firstError && successfulQueries.length === 0 ? firstError : undefined;

  const items = useMemo(() => {
    const merged: WorkloadSummary[] = [];
    for (const q of queries) {
      if (q.data) merged.push(...q.data);
    }
    return sortWorkloads(merged, null);
  }, [queries]);

  // Per-resource favorites — D10 finish. Reuses the existing pinned-
  // resources store: favorites and pins are conceptually the same
  // ("things I want one click away"), and reusing means the cluster
  // sidebar's Pinned section gets the new starred rows for free.
  const favorites = usePinnedResources(context);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const hasFavoritesInView = useMemo(() => {
    return items.some((w) =>
      favorites.isPinned({
        kind: w.kind,
        namespace: w.namespace,
        name: w.name,
      }),
    );
  }, [items, favorites]);
  // If the user filters to favorites and then unstars the last one in
  // view, drop the filter so they don't see a permanently empty table.
  useEffect(() => {
    if (favoritesOnly && !hasFavoritesInView) setFavoritesOnly(false);
  }, [favoritesOnly, hasFavoritesInView]);

  // Lumen-distinct filter DSL — typed tokens AND-combine. Supported:
  //   status:running        → match pod_phase exactly
  //   ns:dev                → match namespace (substring)
  //   kind:pod              → match kind exactly
  //   node:aks-agentp       → match node_name substring
  //   qos:guaranteed        → match qos_class
  //   restarts:>0           → numeric comparison on restart_count
  //   restarts:>=5          → "
  //   <bare word>           → matches name OR namespace (legacy behavior)
  // Plain text remains backward-compatible — typing "order-svc" still works.
  const filteredItems = useMemo(() => {
    const tokens = parseFilterTokens(search);
    if (
      tokens.length === 0 &&
      quickFilters.size === 0 &&
      !favoritesOnly
    ) {
      return items;
    }
    return items.filter(
      (w) =>
        tokens.every((t) => matchToken(w, t)) &&
        matchQuickFilters(w, quickFilters) &&
        (!favoritesOnly ||
          favorites.isPinned({
            kind: w.kind,
            namespace: w.namespace,
            name: w.name,
          })),
    );
  }, [items, search, quickFilters, favoritesOnly, favorites]);
  const visibleItems = useMemo(
    () => sortWorkloads(filteredItems, sort),
    [filteredItems, sort],
  );
  const visibleKeys = useMemo(
    () => selectVisibleWorkloadKeys(visibleItems),
    [visibleItems],
  );
  const selectedItems = useMemo(
    () => items.filter((w) => selectedKeys.has(workloadSelectionKey(w))),
    [items, selectedKeys],
  );
  const selectedRestartableItems = useMemo(
    () => restartEligibleWorkloads(selectedItems),
    [selectedItems],
  );
  const selectedSkipRestartCount = selectedItems.length - selectedRestartableItems.length;
  const selectedTargets = useMemo<PreflightTarget[]>(
    () =>
      selectedItems.map((item) => ({
        kind: item.kind,
        namespace: item.namespace || null,
        name: item.name,
        replicas: parseReadyReplicas(item.ready) ?? (item.kind === "pod" ? 1 : null),
        currentReplicas:
          parseReadyReplicas(item.ready) ?? (item.kind === "pod" ? 1 : null),
      })),
    [selectedItems],
  );
  const selectedRestartableTargets = useMemo<PreflightTarget[]>(
    () =>
      selectedRestartableItems.map((item) => ({
        kind: item.kind,
        namespace: item.namespace || null,
        name: item.name,
        replicas: parseReadyReplicas(item.ready),
        currentReplicas: parseReadyReplicas(item.ready),
      })),
    [selectedRestartableItems],
  );
  const bulkDeletePreflight = useMemo(
    () => buildActionPreflight({ actionType: "delete", targets: selectedTargets }),
    [selectedTargets],
  );
  const bulkRestartPreflight = useMemo(
    () =>
      buildActionPreflight({
        actionType: "restart",
        targets: selectedRestartableTargets,
        note:
          selectedSkipRestartCount > 0
            ? `${selectedSkipRestartCount} selected resource${selectedSkipRestartCount === 1 ? "" : "s"} will be skipped.`
            : undefined,
      }),
    [selectedRestartableTargets, selectedSkipRestartCount],
  );
  const allVisibleSelected =
    visibleItems.length > 0 &&
    visibleItems.every((w) => selectedKeys.has(workloadSelectionKey(w)));
  const someVisibleSelected =
    visibleItems.some((w) => selectedKeys.has(workloadSelectionKey(w))) &&
    !allVisibleSelected;

  useEffect(() => {
    setSelectedKeys((prev) => {
      const next = new Set([...prev].filter((key) => visibleKeys.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleKeys]);

  const hasFilters =
    search.trim().length > 0 || quickFilters.size > 0 || favoritesOnly;
  const explorerStats = useMemo(() => {
    const pods = items.filter((w) => w.kind === "pod");
    const failed = items.filter((w) => w.health === "failed" || w.pod_phase === "Failed").length;
    const degraded = items.filter(
      (w) =>
        w.health === "degraded" ||
        w.pod_phase === "Pending" ||
        (w.restart_count ?? 0) > 0,
    ).length;
    const restarts = items.reduce((sum, w) => sum + (w.restart_count ?? 0), 0);
    const nodes = new Set(items.flatMap((w) => (w.node_name ? [w.node_name] : []))).size;
    const namespacesSeen = new Set(items.map((w) => w.namespace)).size;
    return { pods: pods.length, failed, degraded, restarts, nodes, namespacesSeen };
  }, [items]);

  function toggleQuickFilter(filter: QuickFilter) {
    setQuickFilters((prev) => {
      const next = new Set(prev);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return next;
    });
  }

  function clearFilters() {
    setSearch("");
    setQuickFilters(new Set());
    setFavoritesOnly(false);
  }

  function toggleSort(key: WorkloadSortKey) {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, direction: "asc" };
      if (prev.direction === "asc") return { key, direction: "desc" };
      return null;
    });
  }

  function toggleSelected(w: WorkloadSummary) {
    const key = workloadSelectionKey(w);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllVisibleSelected() {
    setSelectedKeys((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const key of visibleKeys) next.delete(key);
        return next;
      }
      return new Set([...prev, ...visibleKeys]);
    });
  }

  async function invalidateWorkloadResources() {
    await qc.invalidateQueries({ queryKey: ["k8s", "workloads"] });
    await qc.invalidateQueries({ queryKey: ["k8s", "resource-meta"] });
    await qc.invalidateQueries({ queryKey: ["k8s", "resource-action-meta"] });
  }

  async function handleBulkDelete() {
    if (bulkBusy || selectedItems.length === 0 || readOnly) return;
    setBulkBusy(true);
    try {
      for (const item of selectedItems) {
        await k8s.deleteResource(item.namespace, item.kind, item.name, context || undefined);
      }
      toast.success(`deleted ${selectedItems.length} workload${selectedItems.length === 1 ? "" : "s"}`);
      setSelectedKeys(new Set());
      setPendingBulkAction(null);
      await invalidateWorkloadResources();
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkRestart() {
    if (bulkBusy || selectedRestartableItems.length === 0 || readOnly) return;
    setBulkBusy(true);
    try {
      for (const item of selectedRestartableItems) {
        await k8s.restartWorkload(item.namespace, item.kind, item.name, context || undefined);
      }
      toast.success(
        `restart triggered for ${selectedRestartableItems.length} workload${selectedRestartableItems.length === 1 ? "" : "s"}`,
      );
      setSelectedKeys(new Set());
      setPendingBulkAction(null);
      await invalidateWorkloadResources();
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setBulkBusy(false);
    }
  }

  function selectKind(kind: WorkloadKind | null) {
    const base = `/cluster/${encodeURIComponent(context)}/workloads`;
    if (!kind) {
      navigate(base);
      return;
    }
    const definition = listResourceDefinitions().find((item) => item.kind === kind);
    navigate(`${base}/${definition?.slug ?? kind}`);
  }

  const refetchAll = () => queries.forEach((q) => q.refetch());

  // ─── Detail surface ───────────────────────────────────────────────────

  const recent = useRecentResources(context);
  const [drawerResource, setDrawerResource] = useState<{
    kind: string;
    namespace: string;
    name: string;
  } | null>(null);

  const openResource = (w: WorkloadSummary) => {
    recent.push({ kind: w.kind, namespace: w.namespace, name: w.name });
    setDrawerResource({ kind: w.kind, namespace: w.namespace, name: w.name });
  };

  // ─── render ─────────────────────────────────────────────────────────────

  const title = filterKind ? resourceKindLabel(filterKind).toLowerCase() : "workloads";
  const nsLabel = namespace || "all namespaces";

  return (
    <LumenPage>
      <PageHeader
        eyebrow="Resource explorer"
        title={title}
        icon={<Box className="size-3.5" aria-hidden="true" />}
        description={
          <>
            {context} · {nsLabel} · {filteredItems.length} item
            {filteredItems.length === 1 ? "" : "s"}
            {hasFilters && ` · filtered from ${items.length}`}
          </>
        }
        actions={
          <>
            <ResourceKindNav activeKind={filterKind} onSelect={selectKind} />
            <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" />
                <Input
                  ref={searchInputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={isPodView ? "status:running ns:dev restarts:>0" : `search ${title}...`}
                  className="w-[280px] pl-8 text-xs"
                />
              </div>
              <NamespacePicker
                value={namespace}
                namespaces={namespaces}
                onChange={setNamespace}
              />
              <ColumnPicker
                view={isPodView ? "workloads-pod" : "workloads-other"}
                columns={(isPodView ? POD_COLUMNS : OTHER_COLUMNS).map((c) => ({
                  key: c.key,
                  label: c.label,
                  alwaysOn: c.alwaysOn,
                }))}
              />
              <AutoRefreshPicker
                valueSeconds={autoRefreshSeconds}
                onChange={setAutoRefreshSeconds}
              />
              <Button onClick={refetchAll} disabled={isFetching}>
                <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
                refresh
              </Button>
            </div>
          </>
        }
      />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <ExplorerMetric
              icon={<Layers3 className="size-3.5" />}
              label="Resources"
              value={items.length}
              sub={<span>{filteredItems.length} visible</span>}
              tone="info"
              onClick={hasFilters ? clearFilters : undefined}
              actionLabel={hasFilters ? "Clear filters to show all resources" : undefined}
            />
            <ExplorerMetric
              icon={<Activity className="size-3.5" />}
              label="Pods"
              value={explorerStats.pods}
              sub={<span>{isPodView ? "Current view" : "Across workloads"}</span>}
              tone="info"
              onClick={isPodView ? undefined : () => selectKind("pod")}
              actionLabel={isPodView ? undefined : "Switch to pods view"}
            />
            <ExplorerMetric
              icon={<CheckCircle2 className="size-3.5" />}
              label="Healthy"
              value={items.filter((w) => w.health === "healthy").length}
              sub={<span>{explorerStats.namespacesSeen} namespaces</span>}
              tone="good"
            />
            <ExplorerMetric
              icon={<AlertTriangle className="size-3.5" />}
              label="At Risk"
              value={explorerStats.failed + explorerStats.degraded}
              sub={
                <span>
                  {explorerStats.failed + explorerStats.degraded > 0
                    ? `${explorerStats.failed} failed — show only`
                    : `${explorerStats.failed} failed`}
                </span>
              }
              tone={explorerStats.failed > 0 ? "bad" : explorerStats.degraded > 0 ? "warn" : "good"}
              onClick={
                explorerStats.failed + explorerStats.degraded > 0
                  ? () => toggleQuickFilter("unhealthy")
                  : undefined
              }
              active={quickFilters.has("unhealthy")}
              actionLabel="Filter to unhealthy resources"
            />
            <ExplorerMetric
              icon={<RefreshCw className="size-3.5" />}
              label="Restarts"
              value={explorerStats.restarts}
              sub={<span>{explorerStats.restarts > 0 ? "Needs review — show only" : "No restarts"}</span>}
              tone={explorerStats.restarts > 0 ? "warn" : "good"}
              onClick={
                explorerStats.restarts > 0 ? () => toggleQuickFilter("restarts") : undefined
              }
              active={quickFilters.has("restarts")}
              actionLabel="Filter to resources with restarts"
            />
            <ExplorerMetric
              icon={<Server className="size-3.5" />}
              label="Nodes"
              value={explorerStats.nodes || "—"}
              sub={<span>{explorerStats.nodes ? "View all nodes" : "No node data"}</span>}
              tone="muted"
              onClick={() => navigate(`/cluster/${encodeURIComponent(context)}/nodes`)}
              actionLabel="Open nodes view"
            />
          </div>

          <SectionPanel>
            <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
                <Filter className="size-3.5" aria-hidden="true" />
                Filters
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {QUICK_FILTERS.map((filter) => {
                  const active = quickFilters.has(filter.id);
                  return (
                    <button
                      key={filter.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleQuickFilter(filter.id)}
                      className={cn(
                        "h-8 rounded-control border px-2.5 text-[11px] font-medium transition-colors",
                        active
                          ? "border-accent-primary/50 bg-accent-primary-soft text-text-primary"
                          : "border-border-default text-text-secondary hover:bg-hover hover:text-text-primary",
                      )}
                    >
                      {filter.label}
                    </button>
                  );
                })}
                {hasFavoritesInView && (
                  <button
                    type="button"
                    aria-pressed={favoritesOnly}
                    onClick={() => setFavoritesOnly((v) => !v)}
                    className={cn(
                      "inline-flex h-8 items-center gap-1 rounded-control border px-2.5 text-[11px] font-medium transition-colors",
                      favoritesOnly
                        ? "border-term-amber/50 bg-term-amber/10 text-term-amber"
                        : "border-border-default text-text-secondary hover:bg-hover hover:text-text-primary",
                    )}
                  >
                    <Star
                      className={cn(
                        "size-3",
                        favoritesOnly && "fill-current",
                      )}
                      aria-hidden="true"
                    />
                    favorites
                  </button>
                )}
                {hasFilters && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="h-8 rounded-control border border-border-default px-2.5 text-[11px] font-medium text-text-secondary transition hover:bg-hover hover:text-text-primary"
                  >
                    clear
                  </button>
                )}
              </div>
            </div>
            {selectedItems.length > 0 && (
              <BulkActionBar
                selectedCount={selectedItems.length}
                restartableCount={selectedRestartableItems.length}
                skippedRestartCount={selectedSkipRestartCount}
                readOnly={readOnly}
                busy={bulkBusy}
                onRestart={() => setPendingBulkAction("restart")}
                onDelete={() => setPendingBulkAction("delete")}
                onClear={() => setSelectedKeys(new Set())}
              />
            )}
            {Boolean(discoveryError) && (
              <div className="mb-3 rounded-panel border border-warning/30 bg-[var(--status-warning-soft)] p-3 text-xs text-text-secondary">
                Namespace discovery is unavailable. You can still enter a namespace you are authorized to access.
              </div>
            )}
            {isPartial && (
              <div className="mb-3 rounded-panel border border-warning/30 bg-[var(--status-warning-soft)] p-3 text-xs text-text-secondary" role="status">
                <span className="font-medium text-text-primary">Partial data:</span>{" "}
                {failedQueries.map((query) => (query.error as Error).message).join("; ")}
              </div>
            )}
            {totalError ? (
              <div className="flex items-center justify-between gap-4 rounded-panel border border-danger/30 bg-[var(--status-error-soft)] p-4 text-sm text-danger">
                <span className="truncate">Unable to load workloads: {totalError.message}</span>
                <Button
                  onClick={refetchAll}
                  variant="destructive"
                  size="sm"
                >
                  <RefreshCw className="size-3" /> retry
                </Button>
              </div>
            ) : isLoading ? (
              <SkeletonRows
                isPodView={isPodView}
                columnCount={(isPodView ? podVisible : otherVisible).length}
              />
            ) : filteredItems.length === 0 ? (
              <div className="flex items-center justify-between gap-4 rounded-panel border border-border-default bg-surface p-4 text-sm text-text-secondary">
                <span>
                  {hasFilters
                    ? `no matches in ${nsLabel}`
                    : `no ${filterKind ? resourceKindLabel(filterKind).toLowerCase() : "workloads"} in ${nsLabel}`}
                </span>
                {hasFilters && (
                  <Button
                    type="button"
                    onClick={clearFilters}
                    variant="outline"
                    size="sm"
                  >
                    clear filters
                  </Button>
                )}
              </div>
            ) : (
              <DataTableShell>
                <DataTable className={cn(isPodView && "min-w-[1100px]")}>
                  <DataTableHeader>
                    <DataTableRow>
                      <Th />
                      <SelectionHeader
                        checked={allVisibleSelected}
                        indeterminate={someVisibleSelected}
                        disabled={visibleItems.length === 0}
                        onChange={toggleAllVisibleSelected}
                      />
                      <Th />
                      {(isPodView ? podVisible : otherVisible).map((c) => (
                        <Th
                          key={c.key}
                          sortKey={c.sortKey}
                          sort={sort}
                          onSort={toggleSort}
                        >
                          {c.label}
                        </Th>
                      ))}
                    </DataTableRow>
                  </DataTableHeader>
                  <DataTableBody>
                    {visibleItems.map((w) => {
                      const ref = {
                        kind: w.kind,
                        namespace: w.namespace,
                        name: w.name,
                      };
                      const isFav = favorites.isPinned(ref);
                      const isSelected = selectedKeys.has(workloadSelectionKey(w));
                      const onToggleFav = () => favorites.toggle(ref);
                      return isPodView || w.kind === "pod" ? (
                        <PodRow
                          key={`${w.kind}/${w.namespace}/${w.name}`}
                          w={w}
                          columns={podVisible}
                          selected={isSelected}
                          favorited={isFav}
                          onToggleSelected={toggleSelected}
                          onToggleFavorite={onToggleFav}
                          onClick={openResource}
                        />
                      ) : (
                        <Row
                          key={`${w.kind}/${w.namespace}/${w.name}`}
                          w={w}
                          columns={otherVisible}
                          selected={isSelected}
                          favorited={isFav}
                          onToggleSelected={toggleSelected}
                          onToggleFavorite={onToggleFav}
                          onClick={openResource}
                        />
                      );
                    })}
                  </DataTableBody>
                </DataTable>
              </DataTableShell>
            )}
          </SectionPanel>

      {/* Consistent resource detail drawer for every workload kind. */}
      <ResourceDetailDrawer
        ctx={context}
        resource={drawerResource}
        onClose={() => setDrawerResource(null)}
      />
      <PreflightPreviewDialog
        open={pendingBulkAction === "delete"}
        title="preflight delete selected workloads"
        description={`This will delete ${selectedItems.length} selected workload${selectedItems.length === 1 ? "" : "s"} from ${context}. The action is sent to Kubernetes for each selected resource.`}
        impact={bulkDeletePreflight}
        confirmText={`${selectedItems.length} selected`}
        confirmLabel="delete"
        busy={bulkBusy}
        onCancel={() => setPendingBulkAction(null)}
        onConfirm={handleBulkDelete}
      />
      <PreflightPreviewDialog
        open={pendingBulkAction === "restart"}
        title="preflight restart selected workloads"
        description={
          selectedSkipRestartCount > 0
            ? `This will trigger rolling restarts for ${selectedRestartableItems.length} eligible controller workload${selectedRestartableItems.length === 1 ? "" : "s"}. ${selectedSkipRestartCount} selected resource${selectedSkipRestartCount === 1 ? "" : "s"} will be skipped because only deployments, statefulsets, and daemonsets support restart.`
            : `This will trigger rolling restarts for ${selectedRestartableItems.length} selected controller workload${selectedRestartableItems.length === 1 ? "" : "s"}.`
        }
        impact={bulkRestartPreflight}
        confirmText={`${selectedRestartableItems.length} restartable`}
        confirmLabel="restart"
        busy={bulkBusy}
        onCancel={() => setPendingBulkAction(null)}
        onConfirm={handleBulkRestart}
      />
    </LumenPage>
  );
}

function Th({
  children,
  sortKey,
  sort,
  onSort,
}: {
  children?: React.ReactNode;
  sortKey?: WorkloadSortKey;
  sort?: WorkloadSort | null;
  onSort?: (key: WorkloadSortKey) => void;
}) {
  const active = !!sortKey && sort?.key === sortKey;
  return (
    <DataTableHead className="whitespace-nowrap text-[10px]">
      {sortKey && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 py-0.5 uppercase tracking-[0.12em] transition-colors",
            active
              ? "text-text-primary"
              : "text-text-muted hover:bg-hover hover:text-text-primary",
          )}
        >
          <span>{children}</span>
          {active ? (
            sort?.direction === "asc" ? (
              <ArrowUp className="size-3" aria-hidden="true" />
            ) : (
              <ArrowDown className="size-3" aria-hidden="true" />
            )
          ) : null}
        </button>
      ) : (
        children
      )}
    </DataTableHead>
  );
}

function SelectionHeader({
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <DataTableHead className="w-8 px-2">
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label="Select visible workloads"
        onChange={onChange}
        className="size-4 rounded border-border-default bg-elevated accent-[var(--accent-primary)] disabled:opacity-40"
      />
    </DataTableHead>
  );
}

function BulkActionBar({
  selectedCount,
  restartableCount,
  skippedRestartCount,
  readOnly,
  busy,
  onRestart,
  onDelete,
  onClear,
}: {
  selectedCount: number;
  restartableCount: number;
  skippedRestartCount: number;
  readOnly: boolean;
  busy: boolean;
  onRestart: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-control border border-accent-primary/30 bg-accent-primary-soft px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-[12px] font-medium text-text-primary">
        {selectedCount} selected
        {skippedRestartCount > 0 && (
          <span className="ml-2 text-[11px] font-normal text-text-muted">
            {restartableCount} restartable
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || readOnly || restartableCount === 0}
          onClick={onRestart}
          title={readOnly ? "Read-only mode is enabled" : undefined}
        >
          <RotateCw className="size-3.5" />
          Restart
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={busy || readOnly}
          onClick={onDelete}
          title={readOnly ? "Read-only mode is enabled" : undefined}
        >
          <Trash2 className="size-3.5" />
          Delete
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClear}>
          <X className="size-3.5" />
          Clear
        </Button>
      </div>
    </div>
  );
}
