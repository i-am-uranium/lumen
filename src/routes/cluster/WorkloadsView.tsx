import React, { memo, useCallback, useMemo, useRef, useState } from "react";
import { useFocusSearch } from "@/lib/focusSearch";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Box,
  CheckCircle2,
  Filter,
  Layers3,
  RefreshCw,
  Search,
  Server,
} from "lucide-react";
import { k8s, type WorkloadKind, type WorkloadSummary } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { useK8sWatch } from "@/hooks/useK8sWatch";
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
import { ColumnPicker } from "@/components/ColumnPicker";
import { useUiSettings } from "@/state/uiSettings";

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
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  tone?: "good" | "warn" | "bad" | "info" | "muted";
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
    <MetricCard icon={icon} label={label} value={value} helper={sub} tone={mappedTone} />
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
  alwaysOn?: boolean;
  cell: (w: WorkloadSummary) => React.ReactNode;
};

const OTHER_COLUMNS: WorkloadColumn[] = [
  {
    key: "name",
    label: "name",
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
    cell: (w) => (
      <DataTableCell mono className="text-[11px]">
        {w.namespace}
      </DataTableCell>
    ),
  },
  {
    key: "kind",
    label: "kind",
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
    cell: (w) => (
      <DataTableCell mono className="text-[11px] tabular-nums">
        {w.ready || "—"}
      </DataTableCell>
    ),
  },
  {
    key: "health",
    label: "health",
    cell: (w) => (
      <DataTableCell>
        <StatusBadge status={w.health} />
      </DataTableCell>
    ),
  },
  {
    key: "age",
    label: "age",
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
    cell: (w) => (
      <DataTableCell mono className="text-[11px]">
        {w.namespace}
      </DataTableCell>
    ),
  },
  {
    key: "containers",
    label: "containers",
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
    cell: (w) => (
      <DataTableCell mono className="text-[11px] tabular-nums">
        {w.cpu_milli !== undefined ? formatCpu(w.cpu_milli) : "—"}
      </DataTableCell>
    ),
  },
  {
    key: "memory",
    label: "memory",
    cell: (w) => (
      <DataTableCell mono className="text-[11px] tabular-nums">
        {w.mem_bytes !== undefined ? formatBytes(w.mem_bytes) : "—"}
      </DataTableCell>
    ),
  },
  {
    key: "restarts",
    label: "restarts",
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
    cell: (w) => (
      <DataTableCell mono className="max-w-[200px] truncate text-[11px]">
        {w.node_name ?? "—"}
      </DataTableCell>
    ),
  },
  {
    key: "qos",
    label: "qos",
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
    cell: (w) => (
      <DataTableCell className={cn("text-[11px]", statusColor(w.pod_phase))}>
        {w.pod_phase ?? "—"}
      </DataTableCell>
    ),
  },
  {
    key: "age",
    label: "age",
    cell: (w) => (
      <DataTableCell className="text-[11px] tabular-nums">
        {formatAge(w.age_seconds)}
      </DataTableCell>
    ),
  },
];

function visibleColumns(
  columns: WorkloadColumn[],
  hidden: string[],
): WorkloadColumn[] {
  if (hidden.length === 0) return columns;
  return columns.filter((c) => c.alwaysOn || !hidden.includes(c.key));
}

// ─── Generic row (non-pod kinds) ──────────────────────────────────────────

const Row = memo(function Row({
  w,
  columns,
  onClick,
}: {
  w: WorkloadSummary;
  columns: WorkloadColumn[];
  onClick: (w: WorkloadSummary) => void;
}) {
  return (
    <DataTableRow className="cursor-pointer" onClick={() => onClick(w)}>
      <DataTableCell
        className={cn("w-1 p-0", severityBg(w))}
        aria-hidden="true"
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
  onClick,
}: {
  w: WorkloadSummary;
  columns: WorkloadColumn[];
  onClick: (w: WorkloadSummary) => void;
}) {
  return (
    <DataTableRow className="cursor-pointer" onClick={() => onClick(w)}>
      <DataTableCell
        className={cn("w-1 p-0", severityBg(w))}
        aria-hidden="true"
      />
      {columns.map((c) => (
        <React.Fragment key={c.key}>{c.cell(w)}</React.Fragment>
      ))}
    </DataTableRow>
  );
});

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
  // +1 for the leading severity strip column.
  const total = columnCount + 1;
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
  const context = decodeURIComponent(ctx);

  const filterKind: WorkloadKind | null = kindSlug
    ? SLUG_TO_KIND[kindSlug] ?? null
    : null;
  const isPodView = filterKind === "pod";

  // Column visibility — D10. Watching only this view's slot keeps the
  // store subscription scoped; flipping a checkbox doesn't re-render
  // anything outside this route.
  const podHidden = useUiSettings((s) => s.hiddenColumns["workloads-pod"]);
  const otherHidden = useUiSettings((s) => s.hiddenColumns["workloads-other"]);
  const podVisible = useMemo(
    () => visibleColumns(POD_COLUMNS, podHidden),
    [podHidden],
  );
  const otherVisible = useMemo(
    () => visibleColumns(OTHER_COLUMNS, otherHidden),
    [otherHidden],
  );

  const kindsToFetch = filterKind ? [filterKind] : ALL_KINDS;

  // Cmd-K resource jump lands here with ?q=name&ns=namespace pre-set so
  // the user sees the row they picked, already highlighted.
  const [searchParams] = useSearchParams();
  const [namespace, setNamespace] = useState<string>(
    () => searchParams.get("ns") ?? "",
  );
  const [search, setSearch] = useState<string>(
    () => searchParams.get("q") ?? "",
  );
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

  const { data: namespaces = [] } = useQuery({
    queryKey: ["k8s", "namespaces", context],
    queryFn: () => k8s.listNamespaces(context || undefined),
    staleTime: 60_000,
  });

  const queries = useQueries({
    queries: kindsToFetch.map((k) => ({
      queryKey: ["k8s", "workloads", context, namespace, k] as const,
      queryFn: () => k8s.listWorkloads(namespace, k, context || undefined),
      staleTime: 5_000,
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
  });

  const isLoading = queries.some((q) => q.isLoading);
  const isFetching = queries.some((q) => q.isFetching);
  const firstError = queries.find((q) => q.error)?.error as Error | undefined;

  const items = useMemo(() => {
    const merged: WorkloadSummary[] = [];
    for (const q of queries) {
      if (q.data) merged.push(...q.data);
    }
    merged.sort((a, b) => {
      const risk = workloadRiskScore(a) - workloadRiskScore(b);
      if (risk !== 0) return risk;
      if (a.namespace !== b.namespace) return a.namespace.localeCompare(b.namespace);
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.name.localeCompare(b.name);
    });
    return merged;
  }, [queries]);

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
    if (tokens.length === 0 && quickFilters.size === 0) return items;
    return items.filter(
      (w) =>
        tokens.every((t) => matchToken(w, t)) &&
        matchQuickFilters(w, quickFilters),
    );
  }, [items, search, quickFilters]);

  const hasFilters = search.trim().length > 0 || quickFilters.size > 0;
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
              <select
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                className="h-9 rounded-control border border-border-default bg-elevated px-3 py-2 text-xs text-text-primary outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/45"
              >
                <option value="">all namespaces</option>
                {namespaces.map((ns) => (
                  <option key={ns} value={ns}>
                    {ns}
                  </option>
                ))}
              </select>
              <ColumnPicker
                view={isPodView ? "workloads-pod" : "workloads-other"}
                columns={(isPodView ? POD_COLUMNS : OTHER_COLUMNS).map((c) => ({
                  key: c.key,
                  label: c.label,
                  alwaysOn: c.alwaysOn,
                }))}
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
            />
            <ExplorerMetric
              icon={<Activity className="size-3.5" />}
              label="Pods"
              value={explorerStats.pods}
              sub={<span>{isPodView ? "Current view" : "Across workloads"}</span>}
              tone="info"
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
              sub={<span>{explorerStats.failed} failed</span>}
              tone={explorerStats.failed > 0 ? "bad" : explorerStats.degraded > 0 ? "warn" : "good"}
            />
            <ExplorerMetric
              icon={<RefreshCw className="size-3.5" />}
              label="Restarts"
              value={explorerStats.restarts}
              sub={<span>{explorerStats.restarts > 0 ? "Needs review" : "No restarts"}</span>}
              tone={explorerStats.restarts > 0 ? "warn" : "good"}
            />
            <ExplorerMetric
              icon={<Server className="size-3.5" />}
              label="Nodes"
              value={explorerStats.nodes || "—"}
              sub={<span>{explorerStats.nodes ? "Hosting results" : "No node data"}</span>}
              tone="muted"
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
            {firstError ? (
              <div className="flex items-center justify-between gap-4 rounded-panel border border-danger/30 bg-[var(--status-error-soft)] p-4 text-sm text-danger">
                <span className="truncate">{firstError.message}</span>
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
                      {(isPodView ? podVisible : otherVisible).map((c) => (
                        <Th key={c.key}>{c.label}</Th>
                      ))}
                    </DataTableRow>
                  </DataTableHeader>
                  <DataTableBody>
                    {filteredItems.map((w) =>
                      isPodView || w.kind === "pod" ? (
                        <PodRow
                          key={`${w.kind}/${w.namespace}/${w.name}`}
                          w={w}
                          columns={podVisible}
                          onClick={openResource}
                        />
                      ) : (
                        <Row
                          key={`${w.kind}/${w.namespace}/${w.name}`}
                          w={w}
                          columns={otherVisible}
                          onClick={openResource}
                        />
                      ),
                    )}
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
    </LumenPage>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <DataTableHead className="whitespace-nowrap text-[10px]">
      {children}
    </DataTableHead>
  );
}
