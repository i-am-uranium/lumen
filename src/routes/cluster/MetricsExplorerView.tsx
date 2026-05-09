import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Cpu,
  Database,
  Gauge,
  Loader2,
  MemoryStick,
  RefreshCw,
  Search,
  Server,
  SignalZero,
} from "lucide-react";
import { ResourceDetailDrawer } from "@/components/ResourceDetailDrawer";
import {
  k8s,
  type MetricsExplorerPod,
} from "@/lib/k8s";
import {
  formatCpu,
  formatMemory,
  formatPercent,
  summarizeMetricsExplorer,
  type MetricRollup,
  type Pressure,
} from "@/lib/metricsExplorer";
import { cn } from "@/lib/utils";

type DrawerResource = { kind: string; namespace: string; name: string };

const pressureTone: Record<Pressure, string> = {
  unknown: "border-border-default bg-elevated text-text-muted",
  low: "border-success/30 bg-success-soft text-success",
  medium: "border-warning/35 bg-warning-soft text-warning",
  high: "border-warning/45 bg-warning-soft text-warning",
  critical: "border-danger/35 bg-danger-soft text-danger",
};

function MetricCard({
  label,
  metric,
  formatter,
}: {
  label: string;
  metric: MetricRollup;
  formatter: (value: number | null) => string;
}) {
  return (
    <div className="rounded-panel border border-border-subtle bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
          <div className="mt-1 text-[18px] font-semibold tabular-nums text-text-primary">
            {formatter(metric.used)}
          </div>
        </div>
        <span
          className={cn(
            "rounded-[4px] border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
            pressureTone[metric.pressure],
          )}
        >
          {metric.pressure}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] text-text-secondary">
        <span>
          req <b className="font-mono text-text-primary">{formatter(metric.requested)}</b>
        </span>
        <span>
          alloc <b className="font-mono text-text-primary">{formatter(metric.allocatable)}</b>
        </span>
        <span>
          used <b className="font-mono text-text-primary">{formatPercent(metric.usedPercent)}</b>
        </span>
      </div>
    </div>
  );
}

function StateBanner({
  state,
  errors,
}: {
  state: string;
  errors: string[];
}) {
  if (state === "ready" && errors.length === 0) return null;
  const unavailable = state === "metrics-unavailable";
  const Icon = unavailable ? SignalZero : AlertTriangle;
  return (
    <div
      className={cn(
        "mb-4 flex items-start gap-2 rounded-panel border px-3 py-2 text-[12px]",
        unavailable
          ? "border-warning/35 bg-warning-soft text-warning"
          : "border-info/35 bg-info-soft text-info",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div>
        <div className="font-medium">
          {unavailable
            ? "metrics-server unavailable or denied"
            : state === "partial"
              ? "partial metrics data"
              : "no metrics rows yet"}
        </div>
        <div className="mt-0.5 text-[11px] opacity-90">
          {errors.length > 0
            ? errors.join(" · ")
            : "Lumen can still show requests, limits, and allocatable capacity where Kubernetes exposes them."}
        </div>
      </div>
    </div>
  );
}

function ResourceButton({
  pod,
  onOpen,
}: {
  pod: MetricsExplorerPod;
  onOpen: (resource: DrawerResource) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen({ kind: "pod", namespace: pod.namespace, name: pod.name })}
      className="text-left font-mono text-[12px] text-text-primary hover:text-accent-primary"
      title="open pod details"
    >
      {pod.name}
    </button>
  );
}

function PodsTable({
  title,
  pods,
  metric,
  onOpen,
}: {
  title: string;
  pods: MetricsExplorerPod[];
  metric: "cpu" | "memory";
  onOpen: (resource: DrawerResource) => void;
}) {
  return (
    <div className="rounded-panel border border-border-subtle bg-surface">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-2 text-[12px] font-medium text-text-primary">
          {metric === "cpu" ? <Cpu className="size-3.5" /> : <MemoryStick className="size-3.5" />}
          {title}
        </div>
        <span className="text-[11px] text-text-muted">{pods.length} pods</span>
      </div>
      <table className="w-full">
        <thead>
          <tr className="bg-shell">
            <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-text-muted">pod</th>
            <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-text-muted">workload</th>
            <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-text-muted">used</th>
            <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-text-muted">request</th>
          </tr>
        </thead>
        <tbody>
          {pods.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-3 py-6 text-center text-[12px] text-text-muted">
                no pods match the current filters.
              </td>
            </tr>
          ) : (
            pods.map((pod) => (
              <tr key={`${title}-${pod.namespace}-${pod.name}`} className="border-t border-border-subtle">
                <td className="px-3 py-2">
                  <ResourceButton pod={pod} onOpen={onOpen} />
                  <div className="text-[10px] text-text-muted">{pod.namespace}</div>
                </td>
                <td className="px-3 py-2 text-[12px] text-text-secondary">
                  {pod.workload_kind}/{pod.workload_name}
                  <div className="text-[10px] text-text-muted">{pod.node_name ?? "unscheduled"}</div>
                </td>
                <td className="px-3 py-2 text-right font-mono text-[12px] text-text-primary">
                  {metric === "cpu" ? formatCpu(pod.cpu_usage_milli) : formatMemory(pod.mem_usage_bytes)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[12px] text-text-secondary">
                  {metric === "cpu" ? formatCpu(pod.cpu_request_milli) : formatMemory(pod.mem_request_bytes)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function MetricsExplorerView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const [namespace, setNamespace] = useState("");
  const [search, setSearch] = useState("");
  const [drawerResource, setDrawerResource] = useState<DrawerResource | null>(null);

  const namespaces = useQuery({
    queryKey: ["k8s", "namespaces", context],
    queryFn: () => k8s.listNamespaces(context || undefined),
    enabled: !!context,
    staleTime: 30_000,
  });
  const snapshot = useQuery({
    queryKey: ["k8s", "metrics-explorer", context, namespace],
    queryFn: () => k8s.metricsExplorerSnapshot(namespace || undefined, context || undefined),
    enabled: !!context,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const summary = useMemo(
    () =>
      snapshot.data
        ? summarizeMetricsExplorer(snapshot.data, { namespace, search })
        : null,
    [namespace, search, snapshot.data],
  );

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 border-b border-border-subtle bg-app/95 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="mds-heading flex items-center gap-2 text-[20px] text-text-primary">
              <Gauge className="size-5" aria-hidden="true" />
              metrics explorer
            </h1>
            <p className="text-[12px] text-text-secondary">
              {context} · {summary?.filteredPods.length ?? 0} pod{summary?.filteredPods.length === 1 ? "" : "s"} in scope
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="search pods, workloads, nodes"
                className="h-8 w-[240px] rounded-control border border-border-default bg-surface pl-7 pr-2 text-[12px] text-text-primary outline-none focus:border-accent-primary/50"
              />
            </label>
            <select
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              className="h-8 rounded-control border border-border-default bg-surface px-2 text-[12px] text-text-primary outline-none focus:border-accent-primary/50"
              aria-label="filter namespace"
            >
              <option value="">all namespaces</option>
              {(namespaces.data ?? []).map((ns) => (
                <option key={ns} value={ns}>{ns}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => snapshot.refetch()}
              disabled={snapshot.isFetching}
              className="term-btn !min-h-[32px] !px-3 !py-1.5 !text-[12px]"
            >
              {snapshot.isFetching ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              refresh
            </button>
          </div>
        </div>
      </div>

      <div className="p-6">
        {snapshot.error ? (
          <div className="rounded-panel border border-danger/30 bg-danger-soft p-4 text-[13px] text-danger">
            {(snapshot.error as Error).message}
          </div>
        ) : snapshot.isLoading || !summary ? (
          <div className="flex items-center gap-2 text-[13px] text-text-secondary">
            <Loader2 className="size-4 animate-spin" />
            loading metrics...
          </div>
        ) : (
          <>
            <StateBanner state={summary.dataState} errors={summary.errors} />

            <div className="mb-4 grid gap-3 lg:grid-cols-4">
              <MetricCard label="cluster cpu used" metric={summary.cluster.cpu} formatter={formatCpu} />
              <MetricCard label="cluster memory used" metric={summary.cluster.memory} formatter={formatMemory} />
              <div className="rounded-panel border border-border-subtle bg-surface p-3">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-muted">
                  <Server className="size-3.5" /> nodes
                </div>
                <div className="mt-1 text-[18px] font-semibold tabular-nums text-text-primary">
                  {snapshot.data?.nodes.length ?? 0}
                </div>
                <div className="mt-2 text-[11px] text-text-secondary">
                  {summary.nodesByCpuPressure.filter((node) => node.ready).length} ready · top CPU {formatPercent(summary.nodesByCpuPressure[0]?.cpuPercent ?? null)}
                </div>
              </div>
              <div className="rounded-panel border border-border-subtle bg-surface p-3">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-muted">
                  <Database className="size-3.5" /> namespaces
                </div>
                <div className="mt-1 text-[18px] font-semibold tabular-nums text-text-primary">
                  {summary.namespaces.length}
                </div>
                <div className="mt-2 text-[11px] text-text-secondary">
                  {summary.workloads.length} workloads · {snapshot.data?.pods.length ?? 0} pods
                </div>
              </div>
            </div>

            <div className="mb-4 rounded-panel border border-border-subtle bg-surface">
              <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 text-[12px] font-medium text-text-primary">
                <Activity className="size-3.5" />
                namespace rollups
              </div>
              <table className="w-full">
                <thead>
                  <tr className="bg-shell">
                    {["namespace", "pods", "cpu used", "cpu req", "mem used", "mem req"].map((label) => (
                      <th key={label} className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-text-muted">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summary.namespaces.map((row) => (
                    <tr key={row.namespace} className="border-t border-border-subtle">
                      <td className="px-3 py-2 font-mono text-[12px] text-text-primary">{row.namespace}</td>
                      <td className="px-3 py-2 text-[12px] tabular-nums text-text-secondary">{row.podCount}</td>
                      <td className="px-3 py-2 font-mono text-[12px] text-text-secondary">{formatCpu(row.cpu.used)} · {formatPercent(row.cpu.usedPercent)}</td>
                      <td className="px-3 py-2 font-mono text-[12px] text-text-secondary">{formatCpu(row.cpu.requested)} · {formatPercent(row.cpu.requestPercent)}</td>
                      <td className="px-3 py-2 font-mono text-[12px] text-text-secondary">{formatMemory(row.memory.used)} · {formatPercent(row.memory.usedPercent)}</td>
                      <td className="px-3 py-2 font-mono text-[12px] text-text-secondary">{formatMemory(row.memory.requested)} · {formatPercent(row.memory.requestPercent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <PodsTable title="top pods by cpu" pods={summary.topPodsByCpu} metric="cpu" onOpen={setDrawerResource} />
              <PodsTable title="top pods by memory" pods={summary.topPodsByMemory} metric="memory" onOpen={setDrawerResource} />
            </div>

            <div className="mt-4 rounded-panel border border-border-subtle bg-surface">
              <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2 text-[12px] font-medium text-text-primary">
                <Server className="size-3.5" />
                node pressure
              </div>
              <table className="w-full">
                <thead>
                  <tr className="bg-shell">
                    {["node", "cpu", "memory", "allocatable"].map((label) => (
                      <th key={label} className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-text-muted">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summary.nodesByMemoryPressure.slice(0, 10).map((node) => (
                    <tr key={node.name} className="border-t border-border-subtle">
                      <td className="px-3 py-2 font-mono text-[12px] text-text-primary">{node.name}</td>
                      <td className="px-3 py-2 font-mono text-[12px] text-text-secondary">{formatCpu(node.cpu_usage_milli)} · {formatPercent(node.cpuPercent)}</td>
                      <td className="px-3 py-2 font-mono text-[12px] text-text-secondary">{formatMemory(node.mem_usage_bytes)} · {formatPercent(node.memoryPercent)}</td>
                      <td className="px-3 py-2 font-mono text-[12px] text-text-secondary">{formatCpu(node.cpu_allocatable_milli)} · {formatMemory(node.mem_allocatable_bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <ResourceDetailDrawer
        ctx={context}
        resource={drawerResource}
        onClose={() => setDrawerResource(null)}
      />
    </div>
  );
}
