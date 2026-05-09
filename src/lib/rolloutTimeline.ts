import type {
  ArgoApplicationSummary,
  ArgoHistoryEntry,
  EventLine,
  HelmReleaseSummary,
  WorkloadSummary,
} from "./k8s";

export type RolloutTimelineType =
  | "workload_rollout"
  | "pod_churn"
  | "warning_event"
  | "helm_revision"
  | "argo_sync"
  | "argo_health";

export type RolloutTimelineSeverity = "critical" | "warning" | "info" | "success";

export type RolloutTimelineEntry = {
  id: string;
  type: RolloutTimelineType;
  severity: RolloutTimelineSeverity;
  timestampMs: number;
  namespace: string;
  resourceKind: string;
  resourceName: string;
  title: string;
  description: string;
  details: string[];
  correlationKey: string;
  searchText: string;
};

export type RolloutTimelineEvent = EventLine & {
  id?: number;
  receivedAt?: number;
};

export type RolloutTimelineArgoHistory = {
  appName: string;
  appNamespace: string;
  destinationNamespace: string;
  history: ArgoHistoryEntry[];
};

export type RolloutTimelineInput = {
  nowMs: number;
  namespace: string;
  workloads: WorkloadSummary[];
  events: RolloutTimelineEvent[];
  helmReleases: HelmReleaseSummary[];
  argoApplications: ArgoApplicationSummary[];
  argoHistories: RolloutTimelineArgoHistory[];
};

export type RolloutTimelineFilter = {
  resourceKind?: string;
  search?: string;
};

const ROLLOUT_KINDS = new Set(["deployment", "statefulset", "daemonset"]);

function tsMs(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function entrySearchText(entry: Omit<RolloutTimelineEntry, "searchText">): string {
  return [
    entry.type,
    entry.namespace,
    entry.resourceKind,
    entry.resourceName,
    entry.title,
    entry.description,
    ...entry.details,
  ]
    .join(" ")
    .toLowerCase();
}

function withSearchText(entry: Omit<RolloutTimelineEntry, "searchText">): RolloutTimelineEntry {
  return { ...entry, searchText: entrySearchText(entry) };
}

function readyIsShort(w: WorkloadSummary): boolean {
  const match = w.ready.match(/^(\d+)\/(\d+)$/);
  if (!match) return false;
  return Number(match[1]) < Number(match[2]);
}

function rolloutSeverity(w: WorkloadSummary): RolloutTimelineSeverity {
  if (w.health === "failed") return "critical";
  if (w.health === "degraded" || readyIsShort(w)) return "warning";
  return "info";
}

function workloadCorrelationKey(workload: WorkloadSummary): string {
  if (workload.kind !== "pod") return `${workload.namespace}/${workload.name}`;
  const owner = workload.controlled_by;
  if (!owner) return `${workload.namespace}/${workload.name}`;
  if (owner.kind.toLowerCase() === "replicaset") {
    return `${workload.namespace}/${owner.name.replace(/-[a-z0-9]{4,12}$/i, "")}`;
  }
  return `${workload.namespace}/${owner.name}`;
}

function splitInvolved(involved: string): { kind: string; name: string } {
  const ix = involved.indexOf("/");
  if (ix < 0) return { kind: involved || "event", name: "" };
  return { kind: involved.slice(0, ix), name: involved.slice(ix + 1) };
}

function eventNamespace(
  involvedName: string,
  kind: string,
  workloadsByKey: Map<string, WorkloadSummary>,
): string {
  const direct = workloadsByKey.get(`${kind.toLowerCase()}/${involvedName}`);
  if (direct) return direct.namespace;
  const byName = [...workloadsByKey.values()].find((w) => w.name === involvedName);
  return byName?.namespace ?? "";
}

export function buildRolloutTimeline(input: RolloutTimelineInput): RolloutTimelineEntry[] {
  const namespace = input.namespace.trim();
  const namespaceMatches = (value: string) => !namespace || value === namespace;
  const workloads = input.workloads.filter((w) => namespaceMatches(w.namespace));
  const workloadsByKey = new Map(workloads.map((w) => [`${w.kind}/${w.name}`, w]));
  const entries: RolloutTimelineEntry[] = [];

  for (const w of workloads) {
    const createdMs = input.nowMs - Math.max(0, w.age_seconds) * 1000;
    if (ROLLOUT_KINDS.has(w.kind) && (w.health !== "healthy" || readyIsShort(w) || w.age_seconds < 900)) {
      entries.push(
        withSearchText({
          id: `workload-${w.kind}-${w.namespace}-${w.name}`,
          type: "workload_rollout",
          severity: rolloutSeverity(w),
          timestampMs: createdMs,
          namespace: w.namespace,
          resourceKind: w.kind,
          resourceName: w.name,
          title: `${w.kind}/${w.name} rollout signal`,
          description: `${w.ready || "unknown readiness"} · ${w.health}`,
          details: [`age ${Math.round(w.age_seconds / 60)}m`, `namespace ${w.namespace}`],
          correlationKey: workloadCorrelationKey(w),
        }),
      );
    }
    if (
      w.kind === "pod" &&
      ((w.restart_count ?? 0) > 0 ||
        (w.pod_phase && !["Running", "Succeeded"].includes(w.pod_phase)) ||
        w.age_seconds < 600)
    ) {
      entries.push(
        withSearchText({
          id: `pod-${w.namespace}-${w.name}`,
          type: "pod_churn",
          severity: (w.restart_count ?? 0) > 0 || w.health !== "healthy" ? "warning" : "info",
          timestampMs: createdMs,
          namespace: w.namespace,
          resourceKind: "pod",
          resourceName: w.name,
          title: `pod/${w.name} churn`,
          description: `${w.restart_count ?? 0} restarts · ${w.pod_phase ?? w.health}`,
          details: [
            w.controlled_by ? `owner ${w.controlled_by.kind}/${w.controlled_by.name}` : "no owner",
            `age ${Math.round(w.age_seconds / 60)}m`,
          ],
          correlationKey: workloadCorrelationKey(w),
        }),
      );
    }
  }

  for (const event of input.events) {
    if ((event.type_ ?? "").toLowerCase() !== "warning") continue;
    const involved = splitInvolved(event.involved);
    const ns = eventNamespace(involved.name, involved.kind, workloadsByKey);
    if (!namespaceMatches(ns)) continue;
    const matched = workloadsByKey.get(`${involved.kind.toLowerCase()}/${involved.name}`);
    entries.push(
      withSearchText({
        id: `event-${event.id ?? event.receivedAt ?? event.reason}-${involved.kind}-${involved.name}`,
        type: "warning_event",
        severity: "warning",
        timestampMs: tsMs(event.ts, event.receivedAt ?? input.nowMs),
        namespace: ns,
        resourceKind: involved.kind.toLowerCase(),
        resourceName: involved.name,
        title: `${event.reason} warning`,
        description: event.message,
        details: [`involved ${event.involved}`, `count ${"count" in event ? event.count ?? 1 : 1}`],
        correlationKey: matched ? workloadCorrelationKey(matched) : `${ns}/${involved.name}`,
      }),
    );
  }

  for (const release of input.helmReleases.filter((r) => namespaceMatches(r.namespace))) {
    entries.push(
      withSearchText({
        id: `helm-${release.namespace}-${release.name}-${release.revision}`,
        type: "helm_revision",
        severity: release.status.toLowerCase() === "failed" ? "critical" : "success",
        timestampMs: tsMs(release.last_deployed, input.nowMs),
        namespace: release.namespace,
        resourceKind: "helmrelease",
        resourceName: release.name,
        title: `Helm ${release.name} revision ${release.revision}`,
        description: `${release.status} · ${release.chart_name} ${release.chart_version}`,
        details: [
          release.app_version ? `app ${release.app_version}` : "app version unknown",
          release.description ?? "no release description",
        ],
        correlationKey: `${release.namespace}/${release.name}`,
      }),
    );
  }

  for (const history of input.argoHistories.filter((h) => namespaceMatches(h.destinationNamespace))) {
    for (const item of history.history) {
      entries.push(
        withSearchText({
          id: `argo-history-${history.appNamespace}-${history.appName}-${item.revision}`,
          type: "argo_sync",
          severity: "success",
          timestampMs: tsMs(item.deployed_at, input.nowMs),
          namespace: history.destinationNamespace,
          resourceKind: "argocdapplication",
          resourceName: history.appName,
          title: `ArgoCD synced ${history.appName}`,
          description: item.revision,
          details: [item.source_path ?? "source path unknown", `app ns ${history.appNamespace}`],
          correlationKey: `${history.destinationNamespace}/${history.appName}`,
        }),
      );
    }
  }

  for (const app of input.argoApplications.filter((a) => namespaceMatches(a.destination_namespace))) {
    if (app.health_status === "Healthy" && app.sync_status === "Synced") continue;
    entries.push(
      withSearchText({
        id: `argo-health-${app.namespace}-${app.name}`,
        type: "argo_health",
        severity: app.health_status === "Degraded" ? "warning" : "info",
        timestampMs: input.nowMs - Math.max(0, app.age_seconds) * 1000,
        namespace: app.destination_namespace,
        resourceKind: "argocdapplication",
        resourceName: app.name,
        title: `ArgoCD ${app.name} ${app.health_status}`,
        description: `${app.sync_status} · ${app.target_revision}`,
        details: [app.repo_url, app.path],
        correlationKey: `${app.destination_namespace}/${app.name}`,
      }),
    );
  }

  return entries.sort((a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id));
}

export function filterRolloutTimeline(
  entries: RolloutTimelineEntry[],
  filter: RolloutTimelineFilter,
): RolloutTimelineEntry[] {
  const kind = filter.resourceKind?.trim().toLowerCase() ?? "";
  const search = filter.search?.trim().toLowerCase() ?? "";
  return entries.filter((entry) => {
    if (kind && entry.resourceKind.toLowerCase() !== kind) return false;
    if (search && !entry.searchText.includes(search)) return false;
    return true;
  });
}
