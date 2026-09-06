import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileDown,
  FileWarning,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Siren,
  Terminal,
} from "lucide-react";
import { NamespacePicker } from "@/components/NamespacePicker";
import { TriageInvestigation } from "@/components/TriageInvestigation";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { ResourceDetailDrawer } from "@/components/ResourceDetailDrawer";
import { IncidentReportDialog } from "@/components/IncidentReportDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LumenPage, PageHeader, SectionPanel } from "@/components/lumen/page";
import { MetricCard, type MetricTone } from "@/components/lumen/metric-card";
import { useK8sWatch } from "@/hooks/useK8sWatch";
import { k8s, type EventLine, type WorkloadKind } from "@/lib/k8s";
import {
  buildTriageIssues,
  triageIssueCountsBySeverity,
  type TriageGroup,
  type TriageIssue,
  type TriageResourceRef,
  type TriageSeverity,
} from "@/lib/triage";
import { cn } from "@/lib/utils";

const EVENT_AVAILABILITY_UNVERIFIED = "Live warning event availability is unverified. Access and ongoing connection health cannot be confirmed.";

const TRIAGE_KINDS: WorkloadKind[] = [
  "pod",
  "deployment",
  "statefulset",
  "daemonset",
  "replicaset",
  "replicationcontroller",
  "job",
  "cronjob",
];

const LOGGABLE_KINDS = new Set<WorkloadKind>([
  "pod",
  "deployment",
  "statefulset",
  "daemonset",
  "replicaset",
  "job",
]);

const GROUP_LABELS: Record<TriageGroup, string> = {
  "crashloop-restarts": "restarts",
  "pending-pods": "pending",
  "failed-workloads": "failed",
  "warning-events": "events",
  "node-health": "nodes",
  "degraded-controllers": "controllers",
};

const SEVERITY_STYLES: Record<TriageSeverity, string> = {
  critical: "border-danger/45 bg-[var(--status-error-soft)] text-danger",
  high: "border-warning/45 bg-warning-soft text-warning",
  medium: "border-accent-primary/35 bg-accent-primary-soft text-accent-primary",
  low: "border-border-default bg-elevated text-text-secondary",
};

function logsPath(ctx: string, resource: TriageResourceRef): string | null {
  if (!resource.namespace || !LOGGABLE_KINDS.has(resource.kind)) return null;
  const params = new URLSearchParams({
    ns: resource.namespace,
    kind: resource.kind,
    name: resource.name,
  });
  return `/cluster/${encodeURIComponent(ctx)}/logs?${params.toString()}`;
}

function eventsPath(ctx: string, resource: TriageResourceRef): string {
  const params = new URLSearchParams();
  if (resource.namespace) params.set("ns", resource.namespace);
  return `/cluster/${encodeURIComponent(ctx)}/events${params.size ? `?${params.toString()}` : ""}`;
}

function groupSummary(issues: TriageIssue[]): Array<[TriageGroup, number]> {
  const counts = new Map<TriageGroup, number>();
  for (const issue of issues) {
    counts.set(issue.group, (counts.get(issue.group) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) =>
    GROUP_LABELS[a[0]].localeCompare(GROUP_LABELS[b[0]]),
  );
}

function matchesSearch(issue: TriageIssue, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [
    issue.title,
    issue.severity,
    issue.group,
    issue.resource.kind,
    issue.resource.namespace ?? "",
    issue.resource.name,
    ...issue.evidence,
    ...issue.nextActions,
  ]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

export function TriageView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const [sp, setSp] = useSearchParams();
  const scope = useNamespaceScope(context, sp.get("ns"));
  const namespace = scope.namespace;
  const scopeKey = JSON.stringify([context, namespace]);
  const [selection, setSelection] = useState<{ scopeKey: string; issue: TriageIssue; startedAt: string } | null>(null);
  const investigation = selection?.scopeKey === scopeKey ? selection : null;
  const [eventError, setEventError] = useState(false);
  const [captureStartedAt, setCaptureStartedAt] = useState(() => new Date().toISOString());
  const [eventScope, setEventScope] = useState(scopeKey);
  const [search, setSearch] = useState("");
  const [activeGroup, setActiveGroup] = useState<TriageGroup | "all">("all");
  const [events, setEvents] = useState<EventLine[]>([]);
  const [reportScope, setReportScope] = useState<string | null>(null);
  const [drawerResource, setDrawerResource] = useState<{
    scopeKey: string;
    kind: string;
    namespace: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    setCaptureStartedAt(new Date().toISOString());
    setSelection(null);
    setDrawerResource(null);
    setReportScope(null);
  }, [scopeKey]);

  const workloadQueries = useQueries({
    queries: TRIAGE_KINDS.map((kind) => ({
      queryKey: ["k8s", "triage-workloads", context, namespace, kind] as const,
      queryFn: () => k8s.listWorkloads(namespace, kind, context || undefined),
      staleTime: 5_000,
      enabled: !scope.isLoading,
    })),
  });
  const nodesQuery = useQuery({
    queryKey: ["k8s", "triage-nodes", context],
    queryFn: () => k8s.listNodes(context || undefined),
    staleTime: 5_000,
  });

  const queryKeysForWatch = useMemo(
    () => TRIAGE_KINDS.map((kind) => ["k8s", "triage-workloads", context, namespace, kind]),
    [context, namespace],
  );
  useK8sWatch({
    queryKeys: queryKeysForWatch,
    command: "watch_workloads",
    args: { context: context || undefined, namespace: namespace || null },
    enabled: !scope.isLoading,
  });

  useEffect(() => {
    setEvents([]);
    setEventScope(scopeKey);
    setEventError(false);
    if (scope.isLoading) return;
    let active = true;
    const streamId = `triage-events-${crypto.randomUUID()}`;
    const channel = new Channel<EventLine>();
    channel.onmessage = (line) => {
      if (!active || line.type_ !== "Warning") return;
      setEvents((prev) => [line, ...prev].slice(0, 80));
    };
    Promise.resolve(invoke("stream_events", {
      namespace: namespace || null, streamId, channel, context: context || undefined,
    })).then(() => {
      if (!active) void Promise.resolve(invoke("stop_stream", { streamId })).catch(() => {});
    }).catch(() => { if (active) setEventError(true); });
    return () => {
      active = false;
      void Promise.resolve(invoke("stop_stream", { streamId })).catch(() => {});
    };
  }, [context, namespace, scopeKey, scope.isLoading]);
  const scopedEvents = useMemo(() => eventScope === scopeKey ? events : [], [eventScope, scopeKey, events]);

  const workloads = useMemo(
    () => workloadQueries.flatMap((query) => query.data ?? []),
    [workloadQueries],
  );
  const issues = useMemo(
    () =>
      buildTriageIssues({
        context,
        workloads,
        nodes: nodesQuery.data ?? [],
        events: scopedEvents.map((event) => ({ ...event, namespace: namespace || null })),
      }),
    [context, workloads, nodesQuery.data, scopedEvents, namespace],
  );
  const filteredIssues = useMemo(
    () =>
      issues.filter(
        (issue) =>
          (activeGroup === "all" || issue.group === activeGroup) &&
          matchesSearch(issue, search),
      ),
    [activeGroup, issues, search],
  );
  const counts = useMemo(() => triageIssueCountsBySeverity(issues), [issues]);
  const groups = useMemo(() => groupSummary(issues), [issues]);
  const reportIssues = useMemo(
    () =>
      search.trim() || activeGroup !== "all"
        ? filteredIssues
        : issues,
    [activeGroup, filteredIssues, issues, search],
  );

  const isLoading = scope.isLoading || workloadQueries.some((query) => query.isPending) || nodesQuery.isPending;
  const eventAvailability = eventError
    ? "Live warning events unavailable: stream startup failed."
    : EVENT_AVAILABILITY_UNVERIFIED;
  const isFetching = workloadQueries.some((query) => query.isFetching) || nodesQuery.isFetching;
  const unavailable = [
    ...workloadQueries.flatMap((query, index) => query.isError ? [TRIAGE_KINDS[index]] : []),
    ...(nodesQuery.isError ? ["nodes"] : []),
    ...(eventError ? ["live warning events"] : []),
    ...(scope.discoveryError ? ["namespace discovery"] : []),
  ];
  const totalFailure = !scope.isLoading && workloadQueries.every((query) => query.isError) && issues.length === 0;
  const partial = unavailable.length > 0;

  const refetchAll = useCallback(() => {
    if (scope.isLoading) return;
    workloadQueries.forEach((query) => void query.refetch());
    void nodesQuery.refetch();
  }, [nodesQuery, workloadQueries, scope.isLoading]);

  function openResource(resource: TriageResourceRef) {
    setDrawerResource({
      scopeKey,
      kind: resource.kind,
      namespace: resource.namespace ?? "",
      name: resource.name,
    });
  }

  return (
    <LumenPage>
      <PageHeader
        eyebrow="Health inbox"
        title="Incident triage"
        icon={<Siren className="size-3.5" aria-hidden="true" />}
        description={
          <>
            {context} · {namespace || "all namespaces"} · {issues.length} active issue{issues.length === 1 ? "" : "s"} from
            workload and node checks, plus received warning events
          </>
        }
        actions={
          <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
            <NamespacePicker value={namespace} namespaces={scope.namespaces} onChange={(next) => {
              scope.setNamespace(next);
              setSp((current) => { const params = new URLSearchParams(current); params.set("ns", next); return params; }, { replace: true });
              setSelection(null);
              setDrawerResource(null);
              setReportScope(null);
            }} />
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="filter by namespace, resource, evidence..."
                className="w-[300px] pl-8 text-xs"
              />
            </div>
            <Button onClick={refetchAll} disabled={isFetching || scope.isLoading}>
              <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
              refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setReportScope(scopeKey)}
              disabled={!context || isLoading}
            >
              <FileDown className="size-3.5" />
              export report
            </Button>
          </div>
        }
      />

      <div role="status" className="rounded-panel border border-border-default p-3 text-sm text-text-secondary">
        {eventAvailability} Counts reflect received events only; zero does not establish that no warnings exist.
      </div>
      {nodesQuery.isPending && <p role="status" className="text-sm text-text-secondary">Node checks pending. Available workload issues remain visible; report export waits for the request to settle.</p>}
      {partial && <div role="status" className="rounded-panel border border-warning/40 bg-warning-soft p-3 text-sm text-text-secondary">Partial data: {unavailable.join(", ")} unavailable. Counts cover successful sources only.</div>}
      {investigation && <TriageInvestigation context={context} issue={investigation.issue} startedAt={investigation.startedAt} onClose={() => setSelection(null)} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <TriageMetric
          label="Critical"
          value={counts.critical}
          tone={counts.critical ? "error" : "muted"}
          sub={counts.critical ? "Node or severe restart risk" : partial || isLoading ? "Available sources only" : "None in completed checks"}
        />
        <TriageMetric
          label="High"
          value={counts.high}
          tone={counts.high ? "warning" : "muted"}
          sub={counts.high ? "Failed or unstable resources" : partial || isLoading ? "Available sources only" : "None in completed checks"}
        />
        <TriageMetric
          label="Medium"
          value={counts.medium}
          tone={counts.medium ? "info" : "muted"}
          sub={counts.medium ? "Pending, degraded, or warnings" : partial || isLoading ? "Available sources only" : "None in completed checks"}
        />
        <TriageMetric
          label="Warnings received"
          value={scopedEvents.length}
          tone={scopedEvents.length ? "warning" : "muted"}
          sub={eventError ? "Stream startup unavailable" : "Received only; completeness unverified"}
        />
        <TriageMetric
          label="Resources"
          value={workloads.length + (nodesQuery.data?.length ?? 0)}
          tone="muted"
          sub="Scanned locally"
        />
      </div>

      <SectionPanel>
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            <FileWarning className="size-3.5" aria-hidden="true" />
            Issue groups
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <GroupButton
              active={activeGroup === "all"}
              onClick={() => setActiveGroup("all")}
              label="all"
              count={issues.length}
            />
            {groups.map(([group, count]) => (
              <GroupButton
                key={group}
                active={activeGroup === group}
                onClick={() => setActiveGroup(group)}
                label={GROUP_LABELS[group]}
                count={count}
              />
            ))}
          </div>
        </div>

        {totalFailure ? (
          <ErrorState message="Workload sources unavailable for this scope." onRetry={refetchAll} />
        ) : isLoading && filteredIssues.length === 0 ? (
          <LoadingState />
        ) : filteredIssues.length === 0 ? (
          <EmptyState partial={partial} hasIssues={issues.length > 0} onClear={() => {
            setSearch("");
            setActiveGroup("all");
          }} />
        ) : (
          <div className="space-y-3">
            {filteredIssues.map((issue) => (
              <IssueCard
                key={issue.id}
                ctx={context}
                issue={issue}
                onOpenResource={openResource}
                onInvestigate={() => setSelection({ scopeKey, issue, startedAt: new Date().toISOString() })}
              />
            ))}
          </div>
        )}
      </SectionPanel>

      <ResourceDetailDrawer
        ctx={context}
        resource={drawerResource?.scopeKey === scopeKey ? drawerResource : null}
        onClose={() => setDrawerResource(null)}
      />
      <IncidentReportDialog
        key={scopeKey}
        open={reportScope === scopeKey}
        onClose={() => setReportScope(null)}
        loading={isLoading}
        error={totalFailure ? new Error("Workload sources unavailable") : null}
        input={{
          clusterContext: context,
          namespace: namespace || null,
          selectedResource: null,
          triageIssues: reportIssues,
          warningEvents: scopedEvents,
          investigation: {
            startedAt: captureStartedAt,
            sources: [
              ...unavailable.map((name) => `${name}: unavailable`),
              nodesQuery.isPending ? "Node checks: pending" : nodesQuery.isSuccess ? `Node checks: captured ${new Date(nodesQuery.dataUpdatedAt).toISOString()}` : "Node checks: unavailable",
              eventAvailability,
            ],
            observations: [
              "Triage counts cover completed checks and received events only.",
              "Zero received events does not establish that no warnings exist. The event buffer may be incomplete, including when stream startup succeeds.",
            ],
          },
          rolloutEntries: [],
        }}
      />
    </LumenPage>
  );
}

function TriageMetric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number;
  sub: string;
  tone: MetricTone;
}) {
  return (
    <MetricCard
      icon={label === "Resources" ? <Server className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
      label={label}
      value={value}
      helper={<span>{sub}</span>}
      tone={tone}
    />
  );
}

function GroupButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-8 rounded-control border px-2.5 text-[11px] font-medium transition-colors",
        active
          ? "border-accent-primary/50 bg-accent-primary-soft text-text-primary"
          : "border-border-default text-text-secondary hover:bg-hover hover:text-text-primary",
      )}
    >
      {label}
      <span className="ml-1 text-text-muted">{count}</span>
    </button>
  );
}

function IssueCard({
  ctx,
  issue,
  onOpenResource,
  onInvestigate,
}: {
  ctx: string;
  issue: TriageIssue;
  onOpenResource: (resource: TriageResourceRef) => void;
  onInvestigate: () => void;
}) {
  const logs = logsPath(ctx, issue.resource);
  const resourceLabel = `${issue.resource.kind}/${issue.resource.name}`;
  return (
    <article className="rounded-panel border border-border-default bg-surface p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex h-6 items-center rounded-control border px-2 text-[10px] font-semibold uppercase tracking-[0.12em]",
                SEVERITY_STYLES[issue.severity],
              )}
            >
              {issue.severity}
            </span>
            <span className="text-[11px] uppercase tracking-[0.12em] text-text-muted">
              {GROUP_LABELS[issue.group]}
            </span>
          </div>
          <h2 className="mt-2 text-base font-semibold text-text-primary">
            {issue.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-text-secondary">
            {issue.resource.namespace && (
              <>
                <span className="font-mono">{issue.resource.namespace}</span>
                <span className="text-text-muted">/</span>
              </>
            )}
            <span className="font-mono text-text-primary">{resourceLabel}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(issue.resource.namespace || issue.resource.kind === "node") && <Button size="sm" onClick={onInvestigate} aria-label={`investigate ${resourceLabel}`}>investigate</Button>}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenResource(issue.resource)}
            aria-label={`open ${resourceLabel}`}
          >
            <ExternalLink className="size-3.5" />
            open
          </Button>
          {logs && (
            <Button asChild variant="outline" size="sm">
              <Link to={logs}>
                <Terminal className="size-3.5" />
                logs
              </Link>
            </Button>
          )}
          <Button asChild variant="outline" size="sm">
            <Link to={eventsPath(ctx, issue.resource)}>
              <FileWarning className="size-3.5" />
              events
            </Link>
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.7fr)]">
        <div>
          <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            Evidence
          </h3>
          <ul className="mt-2 space-y-1.5">
            {issue.evidence.map((line) => (
              <li key={line} className="flex gap-2 text-[12px] text-text-secondary">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            Next checks
          </h3>
          <ol className="mt-2 space-y-1.5">
            {issue.nextActions.map((action, index) => (
              <li key={action} className="flex gap-2 text-[12px] text-text-secondary">
                <span className="font-mono text-[10px] text-text-muted">{index + 1}</span>
                <span>{action}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </article>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center gap-2 rounded-panel border border-border-default bg-surface p-4 text-sm text-text-secondary">
      <Loader2 className="size-4 animate-spin" />
      Building the health inbox from workloads, nodes, and warning events...
    </div>
  );
}

function EmptyState({
  partial,
  hasIssues,
  onClear,
}: {
  partial: boolean;
  hasIssues: boolean;
  onClear: () => void;
}) {
  if (partial && !hasIssues) return <p className="text-sm text-text-secondary">No issues found in available sources. Unavailable sources have not been assessed.</p>;
  if (hasIssues) {
    return (
      <div className="flex items-center justify-between gap-4 rounded-panel border border-border-default bg-surface p-4 text-sm text-text-secondary">
        <span>No triage issues match the current filter.</span>
        <Button type="button" variant="outline" size="sm" onClick={onClear}>
          clear filters
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-panel border border-border-default bg-surface p-6">
      <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
        <CheckCircle2 className="size-4 text-text-muted" />
        No active triage issues in completed checks
      </div>
      <p className="mt-2 text-sm text-text-secondary">
        No issues were found in completed workload and node checks. Warning stream availability remains unverified; zero received events does not establish that no warnings exist.
      </p>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-panel border border-danger/30 bg-[var(--status-error-soft)] p-4 text-sm text-danger">
      <span className="truncate">{message}</span>
      <Button onClick={onRetry} variant="destructive" size="sm">
        <RefreshCw className="size-3" />
        retry
      </Button>
    </div>
  );
}
