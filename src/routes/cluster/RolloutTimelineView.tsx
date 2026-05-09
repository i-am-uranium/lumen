import { useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Boxes,
  Clock3,
  GitBranch,
  GitCompareArrows,
  History,
  Package,
  RefreshCw,
  Search,
} from "lucide-react";
import { ResourceDetailDrawer } from "@/components/ResourceDetailDrawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LumenPage, PageHeader, SectionPanel, ToolbarSurface } from "@/components/lumen/page";
import { k8s, type WorkloadKind } from "@/lib/k8s";
import {
  buildRolloutTimeline,
  filterRolloutTimeline,
  type RolloutTimelineEntry,
} from "@/lib/rolloutTimeline";
import { summarizeSmartYamlDiff } from "@/lib/smartDiff";
import { cn } from "@/lib/utils";
import { useActivityStream } from "@/state/activityStream";

const TIMELINE_WORKLOAD_KINDS: WorkloadKind[] = [
  "deployment",
  "statefulset",
  "daemonset",
  "pod",
];

const DRAWER_KINDS = new Set<string>([
  "deployment",
  "statefulset",
  "daemonset",
  "pod",
  "replicaset",
  "job",
  "cronjob",
  "service",
  "ingress",
  "networkpolicy",
]);

function formatWhen(timestampMs: number): string {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return d.toLocaleString();
}

function relative(timestampMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function typeLabel(type: RolloutTimelineEntry["type"]): string {
  switch (type) {
    case "workload_rollout":
      return "workload";
    case "pod_churn":
      return "pod churn";
    case "warning_event":
      return "warning";
    case "helm_revision":
      return "helm";
    case "argo_sync":
      return "argocd sync";
    case "argo_health":
      return "argocd health";
  }
}

function entryIcon(type: RolloutTimelineEntry["type"]) {
  if (type === "helm_revision") return Package;
  if (type === "argo_sync" || type === "argo_health") return GitBranch;
  if (type === "warning_event") return AlertTriangle;
  if (type === "pod_churn") return RefreshCw;
  return History;
}

function severityClass(severity: RolloutTimelineEntry["severity"]): string {
  switch (severity) {
    case "critical":
      return "border-danger/40 bg-danger-soft text-danger";
    case "warning":
      return "border-warning/40 bg-warning-soft text-warning";
    case "success":
      return "border-success/40 bg-success-soft text-success";
    case "info":
      return "border-border-default bg-elevated text-text-secondary";
  }
}

function parseKind(value: string): string {
  return value.trim().toLowerCase();
}

export function RolloutTimelineView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [namespace, setNamespace] = useState(sp.get("ns") ?? "");
  const [search, setSearch] = useState(sp.get("q") ?? "");
  const [kindFilter, setKindFilter] = useState(sp.get("kind") ?? "");
  const [drawerResource, setDrawerResource] = useState<{
    kind: string;
    namespace: string;
    name: string;
  } | null>(null);
  const [beforeYaml, setBeforeYaml] = useState("");
  const [afterYaml, setAfterYaml] = useState("");
  const events = useActivityStream((s) => s.entries);
  const nowMs = Date.now();

  const namespaces = useQuery({
    queryKey: ["k8s", "namespaces", context],
    queryFn: () => k8s.listNamespaces(context || undefined),
    staleTime: 60_000,
  });

  const workloadQueries = useQueries({
    queries: TIMELINE_WORKLOAD_KINDS.map((kind) => ({
      queryKey: ["k8s", "rollout-timeline", "workloads", context, namespace, kind],
      queryFn: () => k8s.listWorkloads(namespace, kind, context || undefined),
      staleTime: 10_000,
    })),
  });

  const helm = useQuery({
    queryKey: ["k8s", "rollout-timeline", "helm", context],
    queryFn: () => k8s.listHelmReleases(context || undefined),
    staleTime: 30_000,
  });

  const helmHistoryQueries = useQueries({
    queries: (helm.data ?? []).slice(0, 20).map((release) => ({
      queryKey: [
        "k8s",
        "rollout-timeline",
        "helm-history",
        context,
        release.namespace,
        release.name,
      ],
      queryFn: () =>
        k8s.listHelmHistory(release.namespace, release.name, context || undefined),
      enabled: !namespace || release.namespace === namespace,
      staleTime: 30_000,
    })),
  });

  const argocdAvailable = useQuery({
    queryKey: ["argocd", "available", context],
    queryFn: () => k8s.detectArgocd(context || undefined),
    staleTime: 60_000,
  });

  const argoApps = useQuery({
    queryKey: ["argocd", "rollout-timeline", "apps", context, namespace],
    queryFn: () => k8s.listArgocdApplications(context || undefined, undefined),
    enabled: argocdAvailable.data === true,
    staleTime: 15_000,
  });

  const argoDetailQueries = useQueries({
    queries: (argoApps.data ?? []).slice(0, 20).map((app) => ({
      queryKey: ["argocd", "rollout-timeline", "app", context, app.namespace, app.name],
      queryFn: () =>
        k8s.getArgocdApplication(context || undefined, app.namespace, app.name),
      enabled:
        argocdAvailable.data === true &&
        (!namespace || app.destination_namespace === namespace),
      staleTime: 15_000,
    })),
  });

  const workloads = useMemo(
    () => workloadQueries.flatMap((query) => query.data ?? []),
    [workloadQueries],
  );
  const helmHistories = useMemo(
    () => helmHistoryQueries.flatMap((query) => query.data ?? []),
    [helmHistoryQueries],
  );
  const argoHistories = useMemo(
    () =>
      argoDetailQueries
        .map((query) => query.data)
        .filter((detail): detail is NonNullable<typeof detail> => !!detail)
        .map((detail) => ({
          appName: detail.summary.name,
          appNamespace: detail.summary.namespace,
          destinationNamespace: detail.summary.destination_namespace,
          history: detail.history,
        })),
    [argoDetailQueries],
  );

  const entries = useMemo(
    () =>
      buildRolloutTimeline({
        nowMs,
        namespace,
        workloads,
        events,
        helmReleases: helmHistories.length > 0 ? helmHistories : helm.data ?? [],
        argoApplications: argoApps.data ?? [],
        argoHistories,
      }),
    [argoApps.data, argoHistories, events, helm.data, helmHistories, namespace, nowMs, workloads],
  );

  const visible = useMemo(
    () =>
      filterRolloutTimeline(entries, {
        resourceKind: parseKind(kindFilter),
        search,
      }),
    [entries, kindFilter, search],
  );

  const smartDiff = useMemo(
    () => summarizeSmartYamlDiff(beforeYaml, afterYaml),
    [beforeYaml, afterYaml],
  );

  const isLoading =
    workloadQueries.some((query) => query.isLoading) ||
    helm.isLoading ||
    argocdAvailable.isLoading;
  const error =
    workloadQueries.find((query) => query.error)?.error ??
    helm.error ??
    argoApps.error;

  function persistFilters(next: { ns?: string; q?: string; kind?: string }) {
    const params = new URLSearchParams(sp);
    const ns = next.ns ?? namespace;
    const q = next.q ?? search;
    const kind = next.kind ?? kindFilter;
    if (ns) params.set("ns", ns);
    else params.delete("ns");
    if (q) params.set("q", q);
    else params.delete("q");
    if (kind) params.set("kind", kind);
    else params.delete("kind");
    setSp(params, { replace: true });
  }

  function openEntry(entry: RolloutTimelineEntry) {
    if (DRAWER_KINDS.has(entry.resourceKind) && entry.namespace && entry.resourceName) {
      setDrawerResource({
        kind: entry.resourceKind,
        namespace: entry.namespace,
        name: entry.resourceName,
      });
      return;
    }
    if (entry.type === "helm_revision") {
      navigate(`/cluster/${encodeURIComponent(context)}/helm`);
      return;
    }
    if (entry.type === "argo_sync" || entry.type === "argo_health") {
      navigate(`/cluster/${encodeURIComponent(context)}/argocd`);
    }
  }

  return (
    <LumenPage>
      <PageHeader
        eyebrow="rollout timeline"
        title="deploy correlation"
        icon={<Clock3 className="size-3.5" aria-hidden="true" />}
        description={
          <>
            {context} · {namespace || "all namespaces"} · {visible.length} signal
            {visible.length === 1 ? "" : "s"}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
            <ToolbarSurface className="flex items-center gap-1">
              <select
                value={namespace}
                onChange={(event) => {
                  setNamespace(event.target.value);
                  persistFilters({ ns: event.target.value });
                }}
                className="h-8 rounded-control border border-border-subtle bg-app px-2 text-[12px] text-text-primary"
              >
                <option value="">all namespaces</option>
                {(namespaces.data ?? []).map((ns) => (
                  <option key={ns} value={ns}>
                    {ns}
                  </option>
                ))}
              </select>
              <select
                value={kindFilter}
                onChange={(event) => {
                  setKindFilter(event.target.value);
                  persistFilters({ kind: event.target.value });
                }}
                className="h-8 rounded-control border border-border-subtle bg-app px-2 text-[12px] text-text-primary"
              >
                <option value="">all kinds</option>
                <option value="deployment">deployment</option>
                <option value="statefulset">statefulset</option>
                <option value="daemonset">daemonset</option>
                <option value="pod">pod</option>
                <option value="helmrelease">helm</option>
                <option value="argocdapplication">argocd</option>
              </select>
            </ToolbarSurface>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" />
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  persistFilters({ q: event.target.value });
                }}
                placeholder="search deploy, image, warning..."
                className="w-[280px] pl-8 text-xs"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void namespaces.refetch();
                workloadQueries.forEach((query) => void query.refetch());
                void helm.refetch();
                void argoApps.refetch();
              }}
              className="h-8 gap-1.5 text-xs"
            >
              <RefreshCw className="size-3.5" /> refresh
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <SectionPanel className="min-h-[520px]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text-primary">timeline</h2>
              <p className="text-xs text-text-muted">
                latest deploy, warning, and pod churn signals are grouped by resource name where possible
              </p>
            </div>
            <span className="rounded border border-border-default bg-elevated px-2 py-1 font-mono text-[11px] text-text-secondary">
              {entries.length} total
            </span>
          </div>

          {error ? (
            <div className="flex items-center gap-2 rounded-control border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
              <AlertTriangle className="size-4" />
              {(error as Error).message ?? "timeline data failed to load"}
            </div>
          ) : isLoading ? (
            <div className="flex h-[360px] items-center justify-center text-sm text-text-muted">
              loading rollout signals...
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-[360px] flex-col items-center justify-center text-center text-sm text-text-muted">
              <Boxes className="mb-2 size-6" />
              <p>no rollout signals match the current filters</p>
              <p className="mt-1 max-w-md text-xs">
                Try all namespaces, clear search, or open the Events view so the activity stream has warning events to correlate.
              </p>
            </div>
          ) : (
            <ol className="divide-y divide-border-subtle">
              {visible.map((entry) => {
                const Icon = entryIcon(entry.type);
                return (
                  <li key={entry.id} className="py-3">
                    <button
                      type="button"
                      onClick={() => openEntry(entry)}
                      className="group flex w-full gap-3 rounded-control px-2 py-2 text-left hover:bg-hover"
                    >
                      <span
                        className={cn(
                          "mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-control border",
                          severityClass(entry.severity),
                        )}
                      >
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-text-primary group-hover:text-accent-primary">
                            {entry.title}
                          </span>
                          <span className="rounded border border-border-default bg-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                            {typeLabel(entry.type)}
                          </span>
                          <span className="font-mono text-[11px] text-text-muted">
                            {entry.namespace || "cluster"}
                          </span>
                        </span>
                        <span className="mt-1 block text-xs text-text-secondary">
                          {entry.description}
                        </span>
                        <span className="mt-1 flex flex-wrap gap-1.5">
                          {entry.details.slice(0, 3).map((detail) => (
                            <span
                              key={detail}
                              className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
                            >
                              {detail}
                            </span>
                          ))}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block font-mono text-[11px] text-text-secondary">
                          {relative(entry.timestampMs, nowMs)}
                        </span>
                        <span className="mt-1 block text-[10px] text-text-muted">
                          {formatWhen(entry.timestampMs)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </SectionPanel>

        <SectionPanel>
          <div className="mb-3 flex items-center gap-2">
            <GitCompareArrows className="size-4 text-accent-primary" />
            <div>
              <h2 className="text-sm font-semibold text-text-primary">smart diff</h2>
              <p className="text-xs text-text-muted">paste before/after manifests or rendered Helm output</p>
            </div>
          </div>
          <div className="grid gap-2">
            <textarea
              value={beforeYaml}
              onChange={(event) => setBeforeYaml(event.target.value)}
              placeholder="before YAML"
              spellCheck={false}
              className="h-28 resize-none rounded-control border border-border-subtle bg-code-surface p-2 font-mono text-[11px] text-text-primary outline-none"
            />
            <textarea
              value={afterYaml}
              onChange={(event) => setAfterYaml(event.target.value)}
              placeholder="after YAML"
              spellCheck={false}
              className="h-28 resize-none rounded-control border border-border-subtle bg-code-surface p-2 font-mono text-[11px] text-text-primary outline-none"
            />
          </div>
          <div className="mt-3">
            {!beforeYaml.trim() || !afterYaml.trim() ? (
              <div className="rounded-control border border-border-subtle bg-elevated px-3 py-2 text-xs text-text-muted">
                smart diff highlights image, replicas, env/config refs, probes, resources, routing, network policy, and RBAC changes.
              </div>
            ) : smartDiff.isNoOp ? (
              <div className="rounded-control border border-success/40 bg-success-soft px-3 py-2 text-xs text-success">
                no operationally meaningful changes found
              </div>
            ) : (
              <ul className="space-y-2">
                {smartDiff.changes.slice(0, 8).map((change) => (
                  <li
                    key={`${change.category}-${change.path}`}
                    className="rounded-control border border-border-subtle bg-elevated px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-text-primary">
                        {change.title}
                      </span>
                      <span className="font-mono text-[10px] text-text-muted">
                        {change.category}
                      </span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-text-muted">
                      {change.path}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionPanel>
      </div>

      <ResourceDetailDrawer
        ctx={context}
        resource={drawerResource}
        onClose={() => setDrawerResource(null)}
      />
    </LumenPage>
  );
}
