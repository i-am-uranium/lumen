import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ExternalLink,
  FileWarning,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Siren,
  Terminal,
} from "lucide-react";
import { ResourceDetailDrawer } from "@/components/ResourceDetailDrawer";
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

function issueAiContext(ctx: string, issues: TriageIssue[]): string {
  return [
    "incident_triage_issues:",
    `cluster=${ctx || "unknown"}`,
    issues.length
      ? issues
          .map((issue) =>
            [
              `- severity=${issue.severity}`,
              `group=${issue.group}`,
              `resource=${issue.resource.kind}/${issue.resource.namespace ?? "-"}/${issue.resource.name}`,
              `title=${issue.title}`,
              `evidence=${issue.evidence.join("; ")}`,
              `next=${issue.nextActions.join("; ")}`,
            ].join(" "),
          )
          .join("\n")
      : "none",
  ].join("\n");
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
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [activeGroup, setActiveGroup] = useState<TriageGroup | "all">("all");
  const [events, setEvents] = useState<EventLine[]>([]);
  const [drawerResource, setDrawerResource] = useState<{
    kind: string;
    namespace: string;
    name: string;
  } | null>(null);

  const workloadQueries = useQueries({
    queries: TRIAGE_KINDS.map((kind) => ({
      queryKey: ["k8s", "triage-workloads", context, "", kind] as const,
      queryFn: () => k8s.listWorkloads("", kind, context || undefined),
      staleTime: 5_000,
    })),
  });
  const nodesQuery = useQuery({
    queryKey: ["k8s", "triage-nodes", context],
    queryFn: () => k8s.listNodes(context || undefined),
    staleTime: 5_000,
  });

  const queryKeysForWatch = useMemo(
    () => TRIAGE_KINDS.map((kind) => ["k8s", "triage-workloads", context, "", kind]),
    [context],
  );
  useK8sWatch({
    queryKeys: queryKeysForWatch,
    command: "watch_workloads",
    args: { context: context || undefined },
  });

  useEffect(() => {
    setEvents([]);
    const streamId = `triage-events-${context || "current"}`;
    const channel = new Channel<EventLine>();
    channel.onmessage = (line) => {
      if (line.type_ !== "Warning") return;
      setEvents((prev) => [line, ...prev].slice(0, 80));
    };
    Promise.resolve(invoke("stream_events", {
      namespace: null,
      streamId,
      channel,
      context: context || undefined,
    })).catch(() => {
      // The regular query error surfaces cover workload/node failures. Event
      // streaming is opportunistic here; EventsView remains the full stream.
    });
    return () => {
      Promise.resolve(invoke("stop_stream", { streamId })).catch(() => {});
    };
  }, [context]);

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
        events,
      }),
    [context, workloads, nodesQuery.data, events],
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

  const isLoading = workloadQueries.some((query) => query.isLoading) || nodesQuery.isLoading;
  const isFetching = workloadQueries.some((query) => query.isFetching) || nodesQuery.isFetching;
  const firstError =
    (workloadQueries.find((query) => query.error)?.error as Error | undefined) ??
    (nodesQuery.error as Error | null);

  const refetchAll = useCallback(() => {
    workloadQueries.forEach((query) => void query.refetch());
    void nodesQuery.refetch();
  }, [nodesQuery, workloadQueries]);

  const askAi = useCallback(
    (selectedIssues: TriageIssue[]) => {
      const key = `lumen-ai-context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      window.sessionStorage.setItem(key, issueAiContext(context, selectedIssues));
      navigate(`/cluster/${encodeURIComponent(context)}/ai?task=incident-triage&aiContext=${encodeURIComponent(key)}`);
    },
    [context, navigate],
  );

  function openResource(resource: TriageResourceRef) {
    setDrawerResource({
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
            {context} · {issues.length} active issue{issues.length === 1 ? "" : "s"} from
            workloads, nodes, and live warning events
          </>
        }
        actions={
          <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="filter by namespace, resource, evidence..."
                className="w-[300px] pl-8 text-xs"
              />
            </div>
            <Button onClick={refetchAll} disabled={isFetching}>
              <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
              refresh
            </Button>
            <Button
              type="button"
              onClick={() => askAi(filteredIssues.length ? filteredIssues : issues)}
              disabled={issues.length === 0}
            >
              <Bot className="size-3.5" />
              ask AI
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <TriageMetric
          label="Critical"
          value={counts.critical}
          tone={counts.critical ? "error" : "success"}
          sub={counts.critical ? "Node or severe restart risk" : "No critical issues"}
        />
        <TriageMetric
          label="High"
          value={counts.high}
          tone={counts.high ? "warning" : "success"}
          sub={counts.high ? "Failed or unstable resources" : "No high issues"}
        />
        <TriageMetric
          label="Medium"
          value={counts.medium}
          tone={counts.medium ? "info" : "success"}
          sub={counts.medium ? "Pending, degraded, or warnings" : "No medium issues"}
        />
        <TriageMetric
          label="Warnings"
          value={events.length}
          tone={events.length ? "warning" : "muted"}
          sub="Live event buffer"
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

        {firstError ? (
          <ErrorState message={firstError.message} onRetry={refetchAll} />
        ) : isLoading ? (
          <LoadingState />
        ) : filteredIssues.length === 0 ? (
          <EmptyState hasIssues={issues.length > 0} onClear={() => {
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
                onAskAi={() => askAi([issue])}
              />
            ))}
          </div>
        )}
      </SectionPanel>

      <ResourceDetailDrawer
        ctx={context}
        resource={drawerResource}
        onClose={() => setDrawerResource(null)}
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
  onAskAi,
}: {
  ctx: string;
  issue: TriageIssue;
  onOpenResource: (resource: TriageResourceRef) => void;
  onAskAi: () => void;
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
          <Button type="button" variant="outline" size="sm" onClick={onAskAi}>
            <Bot className="size-3.5" />
            AI
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
  hasIssues,
  onClear,
}: {
  hasIssues: boolean;
  onClear: () => void;
}) {
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
        <CheckCircle2 className="size-4 text-success" />
        No active triage issues
      </div>
      <p className="mt-2 text-sm text-text-secondary">
        Cluster looks quiet from workloads, nodes, and streamed warnings. Keep this page open
        during rollout windows to catch new Warning events as they arrive.
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
