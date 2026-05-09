import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  ExternalLink,
  GitCompareArrows,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { ResourceDetailDrawer } from "@/components/ResourceDetailDrawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  LumenPage,
  PageHeader,
  SectionPanel,
  ToolbarSurface,
} from "@/components/lumen/page";
import {
  compareClusterResources,
  resourceFromWorkloadSummary,
  type ClusterCompareCategory,
  type ClusterCompareResource,
  type ClusterCompareRow,
  type ClusterCompareSeverity,
} from "@/lib/clusterCompare";
import { k8s, type PodDetails, type WorkloadKind, type WorkloadSummary } from "@/lib/k8s";
import { cn } from "@/lib/utils";

const COMPARE_KINDS: WorkloadKind[] = [
  "deployment",
  "statefulset",
  "daemonset",
  "pod",
  "job",
  "cronjob",
  "service",
  "configmap",
  "secret",
];

const POD_DETAIL_LIMIT = 40;

type KindFilter = "all" | WorkloadKind;
type DrawerTarget = {
  ctx: string;
  resource: { kind: string; namespace: string; name: string };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowTone(severity: ClusterCompareSeverity): string {
  if (severity === "high") return "border-danger/35 bg-[var(--status-error-soft)] text-danger";
  if (severity === "medium") {
    return "border-warning/30 bg-[var(--status-warning-soft)] text-warning";
  }
  return "border-border-default bg-elevated text-text-secondary";
}

function categoryVariant(category: ClusterCompareCategory) {
  if (category === "missing" || category === "status" || category === "image") {
    return "destructive" as const;
  }
  if (category === "extra" || category === "replicas" || category === "restarts") {
    return "warning" as const;
  }
  if (category === "config" || category === "helm" || category === "argocd") {
    return "info" as const;
  }
  return "secondary" as const;
}

function selectClassName() {
  return "h-9 rounded-control border border-border-default bg-shell px-2 text-[13px] text-text-primary outline-none focus:border-accent-primary";
}

function resourceKey(resource: Pick<WorkloadSummary, "namespace" | "name">): string {
  return `${resource.namespace}/${resource.name}`;
}

function podImagesByKey(details: Array<PodDetails | undefined>): Map<string, ClusterCompareResource["images"]> {
  const out = new Map<string, ClusterCompareResource["images"]>();
  for (const detail of details) {
    if (!detail) continue;
    out.set(
      `${detail.namespace}/${detail.name}`,
      detail.containers.map((container) => ({
        container: container.name,
        image: container.image,
      })),
    );
  }
  return out;
}

function enrichWithPodImages(
  rows: WorkloadSummary[],
  imagesByPod: Map<string, ClusterCompareResource["images"]>,
): ClusterCompareResource[] {
  return rows.map((row) => {
    const resource = resourceFromWorkloadSummary(row);
    if (row.kind !== "pod") return resource;
    return {
      ...resource,
      images: imagesByPod.get(resourceKey(row)) ?? [],
    };
  });
}

function flattenSuccessfulRows(
  queries: UseQueryResult<WorkloadSummary[]>[],
): WorkloadSummary[] {
  return queries.flatMap((query) => (Array.isArray(query.data) ? query.data : []));
}

function DriftMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "bad" | "warn" | "muted";
}) {
  return (
    <div className="rounded-control border border-border-default bg-shell/70 px-3 py-2">
      <div
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "bad" && "text-danger",
          tone === "warn" && "text-warning",
          tone === "muted" && "text-text-primary",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] uppercase tracking-[0.12em] text-text-muted">
        {label}
      </div>
    </div>
  );
}

function ResourceButton({
  label,
  row,
  side,
  onOpen,
}: {
  label: string;
  row: ClusterCompareRow;
  side: "source" | "target";
  onOpen: (resource: ClusterCompareResource) => void;
}) {
  const resource = side === "source" ? row.source : row.target;
  if (!resource) {
    return <span className="text-[12px] text-text-muted">missing</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(resource)}
      className="inline-flex max-w-full items-center gap-1 rounded px-1.5 py-1 text-left font-mono text-[12px] text-text-primary hover:bg-hover"
      title={`open ${label} resource`}
    >
      <span className="truncate">
        {resource.namespace}/{resource.name}
      </span>
      <ExternalLink className="size-3 shrink-0 text-text-muted" aria-hidden="true" />
    </button>
  );
}

export function ClusterCompareView() {
  const { ctx = "" } = useParams();
  const activeContext = decodeURIComponent(ctx);
  const [sourceContext, setSourceContext] = useState(activeContext);
  const [targetContext, setTargetContext] = useState("");
  const [sourceNamespace, setSourceNamespace] = useState("");
  const [targetNamespace, setTargetNamespace] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [search, setSearch] = useState("");
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);

  const contextsQuery = useQuery({
    queryKey: ["k8s", "contexts"],
    queryFn: k8s.listContexts,
    staleTime: 60_000,
  });
  const contexts = contextsQuery.data ?? [];
  const effectiveTargetContext =
    targetContext || contexts.find((item) => item.name !== sourceContext)?.name || "";
  const selectedKinds = kind === "all" ? COMPARE_KINDS : [kind];
  const canCompare = !!sourceContext && !!effectiveTargetContext;

  const sourceNamespaces = useQuery({
    queryKey: ["k8s", "namespaces", sourceContext],
    queryFn: () => k8s.listNamespaces(sourceContext || undefined),
    enabled: !!sourceContext,
    staleTime: 60_000,
  });
  const targetNamespaces = useQuery({
    queryKey: ["k8s", "namespaces", effectiveTargetContext],
    queryFn: () => k8s.listNamespaces(effectiveTargetContext || undefined),
    enabled: !!effectiveTargetContext,
    staleTime: 60_000,
  });

  const sourceQueries = useQueries({
    queries: selectedKinds.map((selectedKind) => ({
      queryKey: [
        "k8s",
        "cluster-compare",
        sourceContext,
        sourceNamespace,
        selectedKind,
      ] as const,
      queryFn: () =>
        k8s.listWorkloads(sourceNamespace, selectedKind, sourceContext || undefined),
      enabled: canCompare,
      staleTime: 15_000,
    })),
  });
  const targetQueries = useQueries({
    queries: selectedKinds.map((selectedKind) => ({
      queryKey: [
        "k8s",
        "cluster-compare",
        effectiveTargetContext,
        targetNamespace,
        selectedKind,
      ] as const,
      queryFn: () =>
        k8s.listWorkloads(
          targetNamespace,
          selectedKind,
          effectiveTargetContext || undefined,
        ),
      enabled: canCompare,
      staleTime: 15_000,
    })),
  });

  const sourceRows = useMemo(() => flattenSuccessfulRows(sourceQueries), [sourceQueries]);
  const targetRows = useMemo(() => flattenSuccessfulRows(targetQueries), [targetQueries]);
  const sourcePodsForDetails = sourceRows
    .filter((row) => row.kind === "pod")
    .slice(0, POD_DETAIL_LIMIT);
  const targetPodsForDetails = targetRows
    .filter((row) => row.kind === "pod")
    .slice(0, POD_DETAIL_LIMIT);

  const sourcePodDetails = useQueries({
    queries: sourcePodsForDetails.map((pod) => ({
      queryKey: ["k8s", "pod-details", sourceContext, pod.namespace, pod.name] as const,
      queryFn: () => k8s.getPodDetails(sourceContext, pod.namespace, pod.name),
      enabled: canCompare,
      staleTime: 20_000,
    })),
  });
  const targetPodDetails = useQueries({
    queries: targetPodsForDetails.map((pod) => ({
      queryKey: [
        "k8s",
        "pod-details",
        effectiveTargetContext,
        pod.namespace,
        pod.name,
      ] as const,
      queryFn: () => k8s.getPodDetails(effectiveTargetContext, pod.namespace, pod.name),
      enabled: canCompare,
      staleTime: 20_000,
    })),
  });

  const sourceImages = useMemo(
    () => podImagesByKey(sourcePodDetails.map((query) => query.data as PodDetails | undefined)),
    [sourcePodDetails],
  );
  const targetImages = useMemo(
    () => podImagesByKey(targetPodDetails.map((query) => query.data as PodDetails | undefined)),
    [targetPodDetails],
  );
  const sourceResources = useMemo(
    () => enrichWithPodImages(sourceRows, sourceImages),
    [sourceImages, sourceRows],
  );
  const targetResources = useMemo(
    () => enrichWithPodImages(targetRows, targetImages),
    [targetImages, targetRows],
  );

  const compared = useMemo(
    () =>
      compareClusterResources({
        source: sourceResources,
        target: targetResources,
        sourceLabel: sourceContext,
        targetLabel: effectiveTargetContext,
        filters: {
          search,
          matchNamespace:
            !sourceNamespace ||
            !targetNamespace ||
            sourceNamespace === targetNamespace,
        },
      }),
    [
      effectiveTargetContext,
      search,
      sourceContext,
      sourceNamespace,
      sourceResources,
      targetNamespace,
      targetResources,
    ],
  );

  const loading =
    contextsQuery.isLoading ||
    sourceNamespaces.isLoading ||
    targetNamespaces.isLoading ||
    sourceQueries.some((query) => query.isLoading) ||
    targetQueries.some((query) => query.isLoading);
  const refreshing =
    sourceQueries.some((query) => query.isFetching) ||
    targetQueries.some((query) => query.isFetching) ||
    sourcePodDetails.some((query) => query.isFetching) ||
    targetPodDetails.some((query) => query.isFetching);
  const errors = [
    contextsQuery.error,
    sourceNamespaces.error,
    targetNamespaces.error,
    ...sourceQueries.map((query) => query.error),
    ...targetQueries.map((query) => query.error),
    ...sourcePodDetails.map((query) => query.error),
    ...targetPodDetails.map((query) => query.error),
  ].filter(Boolean);
  const podDetailTruncated =
    sourceRows.filter((row) => row.kind === "pod").length > POD_DETAIL_LIMIT ||
    targetRows.filter((row) => row.kind === "pod").length > POD_DETAIL_LIMIT;

  function refresh() {
    for (const query of [...sourceQueries, ...targetQueries, ...sourcePodDetails, ...targetPodDetails]) {
      void query.refetch();
    }
  }

  function openResource(side: "source" | "target", resource: ClusterCompareResource) {
    setDrawer({
      ctx: side === "source" ? sourceContext : effectiveTargetContext,
      resource: {
        kind: resource.kind,
        namespace: resource.namespace,
        name: resource.name,
      },
    });
  }

  return (
    <LumenPage>
      <PageHeader
        eyebrow="cluster compare"
        title="Compare operational drift"
        icon={<GitCompareArrows className="size-4" aria-hidden="true" />}
        description="Compare two contexts or namespaces using workload summaries first, then bounded pod image enrichment where available."
        actions={
          <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={!canCompare || refreshing}>
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden="true" />
            refresh
          </Button>
        }
      />

      <SectionPanel>
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div className="grid gap-2 md:grid-cols-2">
            <label className="grid gap-1 text-[12px] text-text-muted">
              source context
              <select
                value={sourceContext}
                onChange={(event) => setSourceContext(event.target.value)}
                className={selectClassName()}
              >
                {contexts.map((context) => (
                  <option key={context.name} value={context.name}>
                    {context.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[12px] text-text-muted">
              source namespace
              <select
                value={sourceNamespace}
                onChange={(event) => setSourceNamespace(event.target.value)}
                className={selectClassName()}
              >
                <option value="">all namespaces</option>
                {(sourceNamespaces.data ?? []).map((namespace) => (
                  <option key={namespace} value={namespace}>
                    {namespace}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="hidden items-end justify-center pb-2 xl:flex">
            <ArrowRight className="size-4 text-text-muted" aria-hidden="true" />
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="grid gap-1 text-[12px] text-text-muted">
              target context
              <select
                value={effectiveTargetContext}
                onChange={(event) => setTargetContext(event.target.value)}
                className={selectClassName()}
              >
                {!effectiveTargetContext && <option value="">select target</option>}
                {contexts.map((context) => (
                  <option key={context.name} value={context.name}>
                    {context.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[12px] text-text-muted">
              target namespace
              <select
                value={targetNamespace}
                onChange={(event) => setTargetNamespace(event.target.value)}
                className={selectClassName()}
              >
                <option value="">all namespaces</option>
                {(targetNamespaces.data ?? []).map((namespace) => (
                  <option key={namespace} value={namespace}>
                    {namespace}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="mt-3 grid gap-2 lg:grid-cols-[220px_minmax(0,1fr)]">
          <label className="grid gap-1 text-[12px] text-text-muted">
            resource kind
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as KindFilter)}
              className={selectClassName()}
            >
              <option value="all">all tracked kinds</option>
              {COMPARE_KINDS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[12px] text-text-muted">
            search
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="filter by name, namespace, status, image, config ref..."
                className="pl-8"
              />
            </div>
          </label>
        </div>
      </SectionPanel>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <DriftMetric label="drifts" value={compared.rows.length} tone="bad" />
        <DriftMetric label="missing" value={compared.counts.missing} tone="bad" />
        <DriftMetric label="extra" value={compared.counts.extra} tone="warn" />
        <DriftMetric
          label="spec/status"
          value={
            compared.counts.status +
            compared.counts.image +
            compared.counts.replicas +
            compared.counts.config
          }
          tone="warn"
        />
        <DriftMetric label="compared" value={compared.compared} tone="muted" />
      </div>

      {errors.length > 0 && (
        <div className="rounded-control border border-warning/35 bg-warning-soft px-3 py-2 text-[12px] text-warning">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <div className="font-medium">Partial data loaded</div>
              <div className="mt-0.5 truncate text-warning/90">
                {errors.slice(0, 2).map(errorMessage).join(" · ")}
                {errors.length > 2 ? ` · ${errors.length - 2} more` : ""}
              </div>
            </div>
          </div>
        </div>
      )}

      {podDetailTruncated && (
        <div className="rounded-control border border-info/30 bg-[var(--status-info-soft)] px-3 py-2 text-[12px] text-info">
          Pod image enrichment is capped at {POD_DETAIL_LIMIT} pods per side; identity,
          status, replica, and restart drift still use all loaded summaries.
        </div>
      )}

      <SectionPanel className="p-0">
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Boxes className="size-4 text-text-muted" aria-hidden="true" />
            <h2 className="truncate text-sm font-semibold text-text-primary">
              drift evidence
            </h2>
          </div>
          <ToolbarSurface className="hidden items-center gap-1 sm:flex">
            <Badge variant="destructive">high</Badge>
            <Badge variant="warning">medium</Badge>
          </ToolbarSurface>
        </div>

        {!canCompare ? (
          <div className="px-4 py-12 text-center text-[13px] text-text-muted">
            Select a source and target context to compare.
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-12 text-[13px] text-text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            comparing summaries...
          </div>
        ) : compared.rows.length === 0 ? (
          <div className="px-4 py-12 text-center text-[13px] text-text-muted">
            No drift matched the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-[13px]">
              <thead className="border-b border-border-subtle bg-elevated/60 text-[11px] uppercase tracking-[0.12em] text-text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">severity</th>
                  <th className="px-3 py-2 font-medium">category</th>
                  <th className="px-3 py-2 font-medium">resource</th>
                  <th className="px-3 py-2 font-medium">source</th>
                  <th className="px-3 py-2 font-medium">target</th>
                  <th className="px-3 py-2 font-medium">evidence</th>
                </tr>
              </thead>
              <tbody>
                {compared.rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-border-subtle/70 hover:bg-hover/60"
                  >
                    <td className="px-4 py-2">
                      <span
                        className={cn(
                          "inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          rowTone(row.severity),
                        )}
                      >
                        {row.severity}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={categoryVariant(row.category)}>{row.category}</Badge>
                    </td>
                    <td className="max-w-[220px] px-3 py-2">
                      <div className="truncate font-mono text-[12px] text-text-primary" title={row.key}>
                        {row.kind}/{row.name}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
                        {row.namespace}
                        {row.targetNamespace && row.targetNamespace !== row.namespace
                          ? ` -> ${row.targetNamespace}`
                          : ""}
                      </div>
                    </td>
                    <td className="max-w-[220px] px-3 py-2">
                      <ResourceButton
                        label="source"
                        row={row}
                        side="source"
                        onOpen={(resource) => openResource("source", resource)}
                      />
                    </td>
                    <td className="max-w-[220px] px-3 py-2">
                      <ResourceButton
                        label="target"
                        row={row}
                        side="target"
                        onOpen={(resource) => openResource("target", resource)}
                      />
                    </td>
                    <td className="px-3 py-2 text-[12px] text-text-secondary">
                      {row.evidence}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>

      <ResourceDetailDrawer
        ctx={drawer?.ctx ?? ""}
        resource={drawer?.resource ?? null}
        onClose={() => setDrawer(null)}
      />
    </LumenPage>
  );
}
