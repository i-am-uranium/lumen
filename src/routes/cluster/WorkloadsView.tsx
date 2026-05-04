import { memo, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Box, RefreshCw, Search } from "lucide-react";
import { k8s, type Health, type WorkloadKind, type WorkloadSummary } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { useK8sWatch } from "@/hooks/useK8sWatch";
import { YamlModal } from "@/components/YamlModal";
import { PinButton } from "@/components/PinButton";
import { ResourceDetailDrawer } from "@/components/ResourceDetailDrawer";
import { useRecentResources } from "@/hooks/useRecentResources";
import { RESOURCE_KIND_BY_SLUG, listResourceDefinitions, resourceKindLabel } from "@/lib/k8s/resourceRegistry";

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

function healthDot(h: Health): string {
  switch (h) {
    case "healthy":
      return "bg-emerald-400";
    case "degraded":
      return "bg-amber-400";
    case "failed":
      return "bg-term-red";
    default:
      return "bg-term-subtle";
  }
}

function statusColor(phase: string | undefined): string {
  switch (phase) {
    case "Running":
    case "Succeeded":
      return "text-emerald-400";
    case "Pending":
      return "text-amber-400";
    case "Failed":
      return "text-term-red";
    default:
      return "text-term-muted";
  }
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
    return "bg-amber-400";
  }
  if (w.health === "healthy" || w.pod_phase === "Running") return "bg-emerald-400";
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
      return "text-emerald-400 border-emerald-400/40 bg-emerald-400/10";
    case "Burstable":
      return "text-term-muted border-term-border-soft bg-term-panel-2";
    case "BestEffort":
      return "text-term-subtle border-term-border-soft";
    default:
      return "text-term-subtle";
  }
}

// ─── Generic row (non-pod kinds) ──────────────────────────────────────────

const Row = memo(function Row({
  w,
  onClick,
}: {
  w: WorkloadSummary;
  onClick: (w: WorkloadSummary) => void;
}) {
  return (
    <tr
      className="border-b border-term-border-soft hover:bg-term-panel-2 cursor-pointer"
      onClick={() => onClick(w)}
    >
      <td className={cn("w-1 p-0", severityBg(w))} aria-hidden="true" />
      <td className="px-3 py-2.5">
        <span className="text-[13px] text-term-fg font-medium">{w.name}</span>
      </td>
      <td className="px-3 py-2.5 text-[11px] text-term-muted font-mono">{w.namespace}</td>
      <td className="px-3 py-2.5">
        <span className="px-1.5 py-0.5 rounded bg-term-panel-2 border border-term-border-soft text-[10px] text-term-muted lowercase">
          {w.kind}
        </span>
      </td>
      <td className="px-3 py-2.5 text-[11px] text-term-muted font-mono tabular-nums">
        {w.ready || "—"}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", healthDot(w.health))} />
          <span className="text-[11px] text-term-muted capitalize">{w.health}</span>
        </div>
      </td>
      <td className="px-3 py-2.5 text-[11px] text-term-muted tabular-nums">
        {formatAge(w.age_seconds)}
      </td>
    </tr>
  );
});

// ─── Pod-specific row (Lens-style enrichment, Lumen aesthetic) ────────────

const PodRow = memo(function PodRow({
  w,
  onClick,
}: {
  w: WorkloadSummary;
  onClick: (w: WorkloadSummary) => void;
}) {
  const ready = w.container_ready_count ?? 0;
  const total = w.container_count ?? 0;
  const restarts = w.restart_count ?? 0;
  return (
    <tr
      className="border-b border-term-border-soft hover:bg-term-panel-2 cursor-pointer"
      onClick={() => onClick(w)}
    >
      <td className={cn("w-1 p-0", severityBg(w))} aria-hidden="true" />
      <td className="px-3 py-2 max-w-[260px]">
        <span className="text-[13px] text-term-fg font-medium font-mono truncate block">
          {w.name}
        </span>
      </td>
      <td className="px-3 py-2 text-[11px] text-term-muted font-mono">{w.namespace}</td>
      <td className="px-3 py-2">
        <ContainerChiclets ready={ready} total={total} />
      </td>
      <td className="px-3 py-2 text-[11px] text-term-muted font-mono tabular-nums">
        {w.cpu_milli !== undefined ? (w.cpu_milli / 1000).toFixed(3) : "—"}
      </td>
      <td className="px-3 py-2 text-[11px] text-term-muted font-mono tabular-nums">
        {w.mem_bytes !== undefined ? formatBytes(w.mem_bytes) : "—"}
      </td>
      <td
        className={cn(
          "px-3 py-2 text-[11px] font-mono tabular-nums",
          restarts > 0 ? "text-amber-400" : "text-term-muted",
        )}
      >
        {restarts}
      </td>
      <td className="px-3 py-2 text-[11px] text-term-muted font-mono truncate max-w-[160px]">
        {w.controlled_by ? `${w.controlled_by.kind} ${w.controlled_by.name}` : "—"}
      </td>
      <td className="px-3 py-2 text-[11px] text-term-muted font-mono truncate max-w-[200px]">
        {w.node_name ?? "—"}
      </td>
      <td className="px-3 py-2">
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
      </td>
      <td className={cn("px-3 py-2 text-[11px]", statusColor(w.pod_phase))}>
        {w.pod_phase ?? "—"}
      </td>
      <td className="px-3 py-2 text-[11px] text-term-muted tabular-nums">
        {formatAge(w.age_seconds)}
      </td>
    </tr>
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
            i < ready ? "bg-emerald-400" : "bg-term-red/70",
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

function SkeletonRows({ isPodView }: { isPodView: boolean }) {
  const columns = isPodView ? 12 : 7;
  return (
    <div className="rounded-lg border border-term-border-soft overflow-hidden">
      <table className={cn("w-full", isPodView && "min-w-[1100px]")}>
        <thead>
          <tr className="bg-term-panel">
            {Array.from({ length: columns }).map((_, i) => (
              <Th key={i}>{i === 0 ? "" : " "}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 8 }).map((_, row) => (
            <tr key={row} className="border-b border-term-border-soft">
              {Array.from({ length: columns }).map((_, col) => (
                <td key={col} className="px-3 py-2.5">
                  <div className="h-3 rounded bg-term-panel-2 animate-pulse" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── view ─────────────────────────────────────────────────────────────────

export function WorkloadsView() {
  const { ctx = "", kind: kindSlug } = useParams();
  const context = decodeURIComponent(ctx);

  const filterKind: WorkloadKind | null = kindSlug
    ? SLUG_TO_KIND[kindSlug] ?? null
    : null;
  const isPodView = filterKind === "pod";

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

  const refetchAll = () => queries.forEach((q) => q.refetch());

  // ─── Detail surfaces (drawer for pods, YamlModal for everything else) ──

  const recent = useRecentResources(context);
  const [drawerResource, setDrawerResource] = useState<{
    kind: string;
    namespace: string;
    name: string;
  } | null>(null);
  const [selected, setSelected] = useState<WorkloadSummary | null>(null);

  const openResource = (w: WorkloadSummary) => {
    recent.push({ kind: w.kind, namespace: w.namespace, name: w.name });
    if (w.kind === "pod") {
      setDrawerResource({ kind: "pod", namespace: w.namespace, name: w.name });
    } else {
      setSelected(w);
    }
  };

  const yamlQuery = useQuery({
    queryKey: selected
      ? ["k8s", "resource", context, selected.namespace, selected.kind, selected.name]
      : ["k8s", "resource", "noop"],
    queryFn: () =>
      k8s.getResource(
        selected!.namespace,
        selected!.kind,
        selected!.name,
        context || undefined,
      ),
    enabled: !!selected,
    staleTime: 5_000,
  });

  // ─── render ─────────────────────────────────────────────────────────────

  const title = filterKind ? resourceKindLabel(filterKind).toLowerCase() : "workloads";
  const nsLabel = namespace || "all namespaces";

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-term-bg/95 backdrop-blur border-b border-term-border-soft flex flex-wrap items-center justify-between px-6 py-4 gap-3">
        <div className="min-w-0">
          <h1 className="mds-heading text-[20px] text-term-fg flex items-center gap-2">
            <Box className="size-5" /> {title}
          </h1>
          <p className="text-[12px] text-term-muted truncate">
            {context} · {nsLabel} · {filteredItems.length} item
            {filteredItems.length === 1 ? "" : "s"}
            {hasFilters && ` · filtered from ${items.length}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-term-subtle pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                isPodView
                  ? "search · status:running ns:dev restarts:>0"
                  : `search ${title}…`
              }
              className="bg-term-panel border border-term-border-soft rounded text-[12px] text-term-fg pl-7 pr-2 py-1.5 min-h-[32px] w-[220px] outline-none hover:border-term-border focus:border-term-green placeholder:text-term-subtle"
            />
          </div>
          <select
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            className="bg-term-panel border border-term-border-soft rounded text-[12px] text-term-fg px-2 py-1.5 min-h-[32px] outline-none hover:border-term-border focus:border-term-green"
          >
            <option value="">all namespaces</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
          <button
            onClick={refetchAll}
            className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
            disabled={isFetching}
          >
            <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} /> refresh
          </button>
          <div className="flex items-center gap-1">
            {QUICK_FILTERS.map((filter) => {
              const active = quickFilters.has(filter.id);
              return (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleQuickFilter(filter.id)}
                  className={cn(
                    "h-8 px-2 rounded border text-[11px] transition-colors",
                    active
                      ? "bg-term-green/10 text-term-green border-term-green/40"
                      : "text-term-muted border-term-border-soft hover:text-term-fg hover:bg-term-panel-2",
                  )}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="p-6">
        {firstError ? (
          <div className="rounded-lg border border-term-red/40 bg-term-red/10 p-4 text-[13px] text-term-red flex items-center justify-between gap-4">
            <span className="truncate">{firstError.message}</span>
            <button
              onClick={refetchAll}
              className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px]"
            >
              <RefreshCw className="size-3" /> retry
            </button>
          </div>
        ) : isLoading ? (
          <SkeletonRows isPodView={isPodView} />
        ) : filteredItems.length === 0 ? (
          <div className="rounded-lg border border-term-border-soft bg-term-panel p-4 text-[13px] text-term-muted flex items-center justify-between gap-4">
            <span>
              {hasFilters
                ? `no matches in ${nsLabel}`
                : `no ${filterKind ? resourceKindLabel(filterKind).toLowerCase() : "workloads"} in ${nsLabel}`}
            </span>
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px]"
              >
                clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-term-border-soft overflow-auto">
            <table className={cn("w-full", isPodView && "min-w-[1100px]")}>
              <thead>
                {isPodView ? (
                  <tr className="bg-term-panel">
                    <Th />
                    <Th>name</Th>
                    <Th>namespace</Th>
                    <Th>containers</Th>
                    <Th>cpu</Th>
                    <Th>memory</Th>
                    <Th>restarts</Th>
                    <Th>controlled by</Th>
                    <Th>node</Th>
                    <Th>qos</Th>
                    <Th>status</Th>
                    <Th>age</Th>
                  </tr>
                ) : (
                  <tr className="bg-term-panel">
                    <Th />
                    <Th>name</Th>
                    <Th>namespace</Th>
                    <Th>kind</Th>
                    <Th>ready</Th>
                    <Th>health</Th>
                    <Th>age</Th>
                  </tr>
                )}
              </thead>
              <tbody>
                {filteredItems.map((w) =>
                  isPodView || w.kind === "pod" ? (
                    <PodRow
                      key={`${w.kind}/${w.namespace}/${w.name}`}
                      w={w}
                      onClick={openResource}
                    />
                  ) : (
                    <Row
                      key={`${w.kind}/${w.namespace}/${w.name}`}
                      w={w}
                      onClick={openResource}
                    />
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pod detail drawer (Lumen-distinct: side-docked, severity strip,
          chiclets, hotkeys L/S/D/Y/Esc). */}
      <ResourceDetailDrawer
        ctx={context}
        resource={drawerResource}
        onClose={() => setDrawerResource(null)}
      />

      {/* YAML modal kept for non-pod kinds until we extend the drawer. */}
      {selected && (
        <YamlModal
          title={`${selected.kind}/${selected.name}`}
          subtitle={selected.namespace}
          yaml={yamlQuery.data?.yaml}
          loading={yamlQuery.isLoading}
          error={yamlQuery.error ? (yamlQuery.error as Error).message : null}
          sensitive={selected.kind === "secret"}
          onClose={() => setSelected(null)}
          editable={
            selected.kind === "secret"
              ? undefined
              : {
                  namespace: selected.namespace,
                  kind: selected.kind,
                  name: selected.name,
                  context: context || undefined,
                }
          }
          pinSlot={
            <PinButton
              ctx={context}
              resource={{
                kind: selected.kind,
                namespace: selected.namespace,
                name: selected.name,
              }}
            />
          }
        />
      )}
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-term-subtle whitespace-nowrap">
      {children}
    </th>
  );
}
