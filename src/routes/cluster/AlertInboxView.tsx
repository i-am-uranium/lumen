import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BellRing,
  CheckCheck,
  Clock3,
  ExternalLink,
  Eye,
  FileWarning,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
  Terminal,
} from "lucide-react";
import { ResourceDetailDrawer } from "@/components/ResourceDetailDrawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LumenPage, PageHeader, SectionPanel } from "@/components/lumen/page";
import { MetricCard, type MetricTone } from "@/components/lumen/metric-card";
import { useK8sWatch } from "@/hooks/useK8sWatch";
import {
  alertResourceKey,
  buildAlertInbox,
  collectRestartCounts,
  summarizeAlertsBySeverity,
  type AlertInboxEvent,
  type AlertInboxItem,
  type AlertResourceRef,
  type AlertSeverity,
} from "@/lib/alertInbox";
import { k8s, type WorkloadKind } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import {
  applyAlertInboxState,
  useAlertInboxStore,
  type StatefulAlertInboxItem,
} from "@/state/alertInbox";
import { useUiSettings } from "@/state/uiSettings";

const ALERT_WORKLOAD_KINDS: WorkloadKind[] = ["deployment", "pod", "job"];
const LOGGABLE_KINDS = new Set<WorkloadKind>(["pod", "deployment", "job"]);

const SEVERITY_STYLES: Record<AlertSeverity, string> = {
  critical: "border-danger/45 bg-[var(--status-error-soft)] text-danger",
  high: "border-warning/45 bg-warning-soft text-warning",
  medium: "border-accent-primary/35 bg-accent-primary-soft text-accent-primary",
  low: "border-border-default bg-elevated text-text-secondary",
  info: "border-border-default bg-elevated text-text-muted",
};

const RULE_LABELS: Record<AlertInboxItem["ruleId"], string> = {
  "deployment-unavailable": "deployment",
  "deployment-degraded": "deployment",
  "pod-restart-increase": "restarts",
  "pod-pending-too-long": "pending",
  "job-failed": "jobs",
  "node-not-ready": "nodes",
  "node-pressure": "nodes",
  "warning-event-spike": "events",
  "risky-service-exposure": "exposure",
};

type StatusFilter = "active" | "all" | "acknowledged" | "snoozed";

function canUseTauriChannel(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function logsPath(ctx: string, resource: AlertResourceRef): string | null {
  if (!resource.namespace || !LOGGABLE_KINDS.has(resource.kind)) return null;
  const params = new URLSearchParams({
    ns: resource.namespace,
    kind: resource.kind,
    name: resource.name,
  });
  return `/cluster/${encodeURIComponent(ctx)}/logs?${params.toString()}`;
}

function eventsPath(ctx: string, resource: AlertResourceRef): string {
  const params = new URLSearchParams();
  if (resource.namespace) params.set("ns", resource.namespace);
  return `/cluster/${encodeURIComponent(ctx)}/events${params.size ? `?${params.toString()}` : ""}`;
}

function relTime(ms: number | null, nowMs: number): string {
  if (ms === null) return "unknown";
  const sec = Math.max(0, Math.floor((nowMs - ms) / 1_000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function formatUntil(ms: number | null): string {
  if (ms === null) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function matchesSearch(alert: StatefulAlertInboxItem, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [
    alert.title,
    alert.severity,
    alert.ruleId,
    alert.resource.kind,
    alert.resource.namespace ?? "",
    alert.resource.name,
    ...alert.evidence,
    ...alert.nextChecks,
  ]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

export function AlertInboxView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const selectedNamespace = useUiSettings(
    (s) => s.selectedNamespaces[context] ?? "",
  );
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [events, setEvents] = useState<AlertInboxEvent[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const tauriChannelAvailable = canUseTauriChannel();
  const [drawerResource, setDrawerResource] = useState<{
    kind: string;
    namespace: string;
    name: string;
  } | null>(null);

  const acknowledged = useAlertInboxStore((s) => s.acknowledged);
  const snoozedUntil = useAlertInboxStore((s) => s.snoozedUntil);
  const read = useAlertInboxStore((s) => s.read);
  const storedRestartCounts = useAlertInboxStore((s) => s.restartCounts);
  const acknowledge = useAlertInboxStore((s) => s.acknowledge);
  const unacknowledge = useAlertInboxStore((s) => s.unacknowledge);
  const snooze = useAlertInboxStore((s) => s.snooze);
  const unsnooze = useAlertInboxStore((s) => s.unsnooze);
  const markRead = useAlertInboxStore((s) => s.markRead);
  const replaceRestartCounts = useAlertInboxStore((s) => s.replaceRestartCounts);
  const prune = useAlertInboxStore((s) => s.prune);

  const workloadQueries = useQueries({
    queries: ALERT_WORKLOAD_KINDS.map((kind) => ({
      queryKey: ["k8s", "alert-inbox-workloads", context, "", kind] as const,
      queryFn: () => k8s.listWorkloads("", kind, context || undefined),
      enabled: !!context && tauriChannelAvailable,
      staleTime: 5_000,
    })),
  });
  const nodesQuery = useQuery({
    queryKey: ["k8s", "alert-inbox-nodes", context],
    queryFn: () => k8s.listNodes(context || undefined),
    enabled: !!context && tauriChannelAvailable,
    staleTime: 5_000,
  });
  const networkQuery = useQuery({
    queryKey: ["k8s", "alert-inbox-network", context, selectedNamespace],
    queryFn: () => k8s.networkDebugSnapshot(selectedNamespace, context || undefined),
    enabled: !!context && !!selectedNamespace && tauriChannelAvailable,
    staleTime: 15_000,
  });

  const watchKeys = useMemo(
    () =>
      ALERT_WORKLOAD_KINDS.map((kind) => [
        "k8s",
        "alert-inbox-workloads",
        context,
        "",
        kind,
      ]),
    [context],
  );
  useK8sWatch({
    queryKeys: watchKeys,
    command: "watch_workloads",
    args: { context: context || undefined },
    enabled: !!context && tauriChannelAvailable,
  });

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setEvents([]);
    if (!context) return;
    if (!tauriChannelAvailable) return;
    const streamId = `alert-inbox-events-${context}`;
    const channel = new Channel<AlertInboxEvent>();
    channel.onmessage = (line) => {
      if ((line.type_ ?? "").toLowerCase() !== "warning") return;
      setEvents((prev) => [line, ...prev].slice(0, 250));
    };
    Promise.resolve(invoke("stream_events", {
      namespace: null,
      streamId,
      channel,
      context: context || undefined,
    })).catch(() => {
      // Event spikes are opportunistic; workload and node queries still power
      // the rest of the inbox if the watch cannot start.
    });
    return () => {
      Promise.resolve(invoke("stop_stream", { streamId })).catch(() => {});
    };
  }, [context, tauriChannelAvailable]);

  const workloads = useMemo(
    () => workloadQueries.flatMap((query) => query.data ?? []),
    [workloadQueries],
  );
  const restartCounts = useMemo(() => collectRestartCounts(workloads), [workloads]);
  const rawAlerts = useMemo(
    () =>
      buildAlertInbox({
        context,
        workloads,
        nodes: nodesQuery.data ?? [],
        events,
        network: networkQuery.data,
        previousRestartCounts: storedRestartCounts,
        nowMs,
      }),
    [context, events, networkQuery.data, nodesQuery.data, nowMs, storedRestartCounts, workloads],
  );
  const persisted = useMemo(
    () => ({
      acknowledged,
      snoozedUntil,
      read,
      restartCounts: storedRestartCounts,
    }),
    [acknowledged, read, snoozedUntil, storedRestartCounts],
  );
  const alerts = useMemo(
    () => applyAlertInboxState(rawAlerts, persisted, nowMs),
    [nowMs, persisted, rawAlerts],
  );

  useEffect(() => {
    if (workloads.length === 0) return;
    replaceRestartCounts(restartCounts);
  }, [replaceRestartCounts, restartCounts, workloads.length]);

  useEffect(() => {
    prune({
      nowMs,
      activeFingerprints: new Set(rawAlerts.map((alert) => alert.fingerprint)),
      activeRestartKeys: new Set(Object.keys(restartCounts)),
    });
  }, [nowMs, prune, rawAlerts, restartCounts]);

  const visibleAlerts = useMemo(
    () =>
      alerts.filter((alert) => {
        if (status === "active" && (alert.acknowledged || alert.snoozed)) return false;
        if (status === "acknowledged" && !alert.acknowledged) return false;
        if (status === "snoozed" && !alert.snoozed) return false;
        return matchesSearch(alert, search);
      }),
    [alerts, search, status],
  );
  const counts = useMemo(() => summarizeAlertsBySeverity(alerts), [alerts]);
  const unread = alerts.filter((alert) => !alert.read && !alert.acknowledged && !alert.snoozed).length;
  const activeCount = alerts.filter((alert) => !alert.acknowledged && !alert.snoozed).length;
  const isLoading = workloadQueries.some((query) => query.isLoading) || nodesQuery.isLoading;
  const isFetching =
    workloadQueries.some((query) => query.isFetching) ||
    nodesQuery.isFetching ||
    networkQuery.isFetching;
  const firstError =
    (workloadQueries.find((query) => query.error)?.error as Error | undefined) ??
    (nodesQuery.error as Error | null) ??
    (networkQuery.error as Error | null);

  const refetchAll = useCallback(() => {
    workloadQueries.forEach((query) => void query.refetch());
    void nodesQuery.refetch();
    if (selectedNamespace) void networkQuery.refetch();
  }, [networkQuery, nodesQuery, selectedNamespace, workloadQueries]);

  function openResource(resource: AlertResourceRef) {
    setDrawerResource({
      kind: resource.kind,
      namespace: resource.namespace ?? "",
      name: resource.name,
    });
  }

  return (
    <LumenPage>
      <PageHeader
        eyebrow="Local operations"
        title="Alert inbox"
        icon={<Inbox className="size-3.5" aria-hidden="true" />}
        description={
          <>
            {context} · {activeCount} active alert{activeCount === 1 ? "" : "s"} from
            workloads, nodes, warning events
            {selectedNamespace ? `, and ${selectedNamespace} network exposure` : ""}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="filter by resource, rule, evidence..."
                className="w-[300px] pl-8 text-xs"
              />
            </div>
            <Button variant="outline" onClick={() => markRead(alerts.map((alert) => alert.fingerprint))} disabled={alerts.length === 0}>
              <Eye className="size-3.5" />
              mark read
            </Button>
            <Button onClick={refetchAll} disabled={isFetching}>
              <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
              refresh
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <InboxMetric
          label="Active"
          value={activeCount}
          tone={activeCount ? "warning" : "success"}
          sub={activeCount ? "Needs operator review" : "Nothing active"}
        />
        <InboxMetric
          label="Critical"
          value={counts.critical}
          tone={counts.critical ? "error" : "success"}
          sub={counts.critical ? "Page immediately" : "None"}
        />
        <InboxMetric
          label="High"
          value={counts.high}
          tone={counts.high ? "warning" : "success"}
          sub={counts.high ? "Likely incident signal" : "None"}
        />
        <InboxMetric
          label="Unread"
          value={unread}
          tone={unread ? "info" : "muted"}
          sub="Local read state"
        />
        <InboxMetric
          label="Warnings"
          value={events.length}
          tone={events.length ? "warning" : "muted"}
          sub="Live event buffer"
        />
      </div>

      <SectionPanel>
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            <BellRing className="size-3.5" aria-hidden="true" />
            Local alert rules
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <FilterButton label="active" active={status === "active"} onClick={() => setStatus("active")} count={activeCount} />
            <FilterButton label="all" active={status === "all"} onClick={() => setStatus("all")} count={alerts.length} />
            <FilterButton
              label="acked"
              active={status === "acknowledged"}
              onClick={() => setStatus("acknowledged")}
              count={alerts.filter((alert) => alert.acknowledged).length}
            />
            <FilterButton
              label="snoozed"
              active={status === "snoozed"}
              onClick={() => setStatus("snoozed")}
              count={alerts.filter((alert) => alert.snoozed).length}
            />
          </div>
        </div>

        {!selectedNamespace && (
          <div className="mb-3 rounded-control border border-border-default bg-elevated/50 px-3 py-2 text-[12px] text-text-secondary">
            Risky service exposure checks run when a namespace filter is selected in this cluster workspace.
          </div>
        )}

        {firstError ? (
          <ErrorState message={firstError.message} onRetry={refetchAll} />
        ) : isLoading ? (
          <LoadingState />
        ) : visibleAlerts.length === 0 ? (
          <EmptyState
            hasAlerts={alerts.length > 0}
            onClear={() => {
              setSearch("");
              setStatus("active");
            }}
          />
        ) : (
          <div className="space-y-3">
            {visibleAlerts.map((alert) => (
              <AlertCard
                key={alert.fingerprint}
                ctx={context}
                alert={alert}
                nowMs={nowMs}
                onOpenResource={openResource}
                onAcknowledge={() => acknowledge(alert.fingerprint)}
                onUnacknowledge={() => unacknowledge(alert.fingerprint)}
                onSnooze={() => snooze(alert.fingerprint, Date.now() + 30 * 60_000)}
                onUnsnooze={() => unsnooze(alert.fingerprint)}
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

function InboxMetric({
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
      icon={<AlertTriangle className="size-3.5" />}
      label={label}
      value={value}
      helper={<span>{sub}</span>}
      tone={tone}
    />
  );
}

function FilterButton({
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

function AlertCard({
  ctx,
  alert,
  nowMs,
  onOpenResource,
  onAcknowledge,
  onUnacknowledge,
  onSnooze,
  onUnsnooze,
}: {
  ctx: string;
  alert: StatefulAlertInboxItem;
  nowMs: number;
  onOpenResource: (resource: AlertResourceRef) => void;
  onAcknowledge: () => void;
  onUnacknowledge: () => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
}) {
  const logs = logsPath(ctx, alert.resource);
  const resourceLabel = `${alert.resource.kind}/${alert.resource.name}`;
  return (
    <article
      className={cn(
        "rounded-panel border bg-surface p-4",
        alert.snoozed || alert.acknowledged
          ? "border-border-default opacity-75"
          : "border-border-default",
        !alert.read && !alert.acknowledged && !alert.snoozed && "shadow-[0_0_0_1px_var(--accent-primary)]",
      )}
    >
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex h-6 items-center rounded-control border px-2 text-[10px] font-semibold uppercase tracking-[0.12em]", SEVERITY_STYLES[alert.severity])}>
              {alert.severity}
            </span>
            <span className="text-[11px] uppercase tracking-[0.12em] text-text-muted">
              {RULE_LABELS[alert.ruleId]}
            </span>
            {alert.acknowledged && (
              <span className="inline-flex h-6 items-center gap-1 rounded-control border border-border-default px-2 text-[10px] uppercase tracking-[0.12em] text-text-muted">
                <CheckCheck className="size-3" />
                acked
              </span>
            )}
            {alert.snoozed && (
              <span className="inline-flex h-6 items-center gap-1 rounded-control border border-border-default px-2 text-[10px] uppercase tracking-[0.12em] text-text-muted">
                <Clock3 className="size-3" />
                until {formatUntil(alert.snoozedUntilMs)}
              </span>
            )}
          </div>
          <h2 className="mt-2 text-base font-semibold text-text-primary">
            {alert.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-text-secondary">
            {alert.resource.namespace && (
              <>
                <span className="font-mono">{alert.resource.namespace}</span>
                <span className="text-text-muted">/</span>
              </>
            )}
            <span className="font-mono text-text-primary">{resourceLabel}</span>
            <span className="text-text-muted">·</span>
            <span>last seen {relTime(alert.lastSeenMs, nowMs)}</span>
            <span className="text-text-muted">·</span>
            <span className="font-mono text-[11px] text-text-muted">{alertResourceKey(alert.resource)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenResource(alert.resource)} aria-label={`open ${resourceLabel}`}>
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
            <Link to={eventsPath(ctx, alert.resource)}>
              <FileWarning className="size-3.5" />
              events
            </Link>
          </Button>
          {alert.acknowledged ? (
            <Button type="button" variant="ghost" size="sm" onClick={onUnacknowledge}>
              unack
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={onAcknowledge}>
              ack
            </Button>
          )}
          {alert.snoozed ? (
            <Button type="button" variant="ghost" size="sm" onClick={onUnsnooze}>
              unsnooze
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={onSnooze}>
              snooze 30m
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.7fr)]">
        <div>
          <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            Evidence
          </h3>
          <ul className="mt-2 space-y-1.5">
            {alert.evidence.map((line) => (
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
            {alert.nextChecks.map((action, index) => (
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
      Building the alert inbox from local cluster data...
    </div>
  );
}

function EmptyState({
  hasAlerts,
  onClear,
}: {
  hasAlerts: boolean;
  onClear: () => void;
}) {
  if (hasAlerts) {
    return (
      <div className="flex items-center justify-between gap-4 rounded-panel border border-border-default bg-surface p-4 text-sm text-text-secondary">
        <span>No alerts match the current filter.</span>
        <Button type="button" variant="outline" size="sm" onClick={onClear}>
          clear filters
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-panel border border-border-default bg-surface p-6">
      <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
        <CheckCheck className="size-4 text-success" />
        No local alerts
      </div>
      <p className="mt-2 text-sm text-text-secondary">
        No deployment, restart, pending pod, failed job, node, warning spike, or selected-namespace exposure alerts are active.
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
