import type { EventLine, NodeSummary, WorkloadKind, WorkloadSummary } from "@/lib/k8s";
import type { NetworkDebugSnapshot, NetworkService } from "@/lib/networkDebugger";

export type AlertSeverity = "critical" | "high" | "medium" | "low" | "info";

export type AlertRuleId =
  | "deployment-unavailable"
  | "deployment-degraded"
  | "pod-restart-increase"
  | "pod-pending-too-long"
  | "job-failed"
  | "node-not-ready"
  | "node-pressure"
  | "warning-event-spike"
  | "risky-service-exposure";

export type AlertResourceRef = {
  kind: WorkloadKind;
  namespace: string | null;
  name: string;
};

export type AlertInboxEvent = Partial<EventLine> & {
  ts?: string | null;
  kind?: string;
  reason?: string;
  message?: string;
  involved?: string;
  type_?: string;
  namespace?: string | null;
  involved_kind?: string;
  involved_name?: string;
  count?: number | null;
};

export type AlertInboxItem = {
  fingerprint: string;
  ruleId: AlertRuleId;
  severity: AlertSeverity;
  title: string;
  resource: AlertResourceRef;
  evidence: string[];
  nextChecks: string[];
  firstSeenMs: number | null;
  lastSeenMs: number | null;
  eventCount?: number;
};

export type AlertInboxInput = {
  context: string;
  workloads: WorkloadSummary[];
  nodes: NodeSummary[];
  events?: AlertInboxEvent[];
  network?: NetworkDebugSnapshot;
  nowMs?: number;
  previousRestartCounts?: Record<string, number>;
  pendingThresholdMs?: number;
  warningSpikeWindowMs?: number;
  warningSpikeThreshold?: number;
};

const DEFAULT_PENDING_THRESHOLD_MS = 15 * 60_000;
const DEFAULT_WARNING_SPIKE_WINDOW_MS = 10 * 60_000;
const DEFAULT_WARNING_SPIKE_THRESHOLD = 3;

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const KIND_ALIASES: Record<string, WorkloadKind> = {
  pod: "pod",
  pods: "pod",
  deployment: "deployment",
  deployments: "deployment",
  job: "job",
  jobs: "job",
  node: "node",
  nodes: "node",
  service: "service",
  services: "service",
};

function namespaceOrNull(namespace: string | null | undefined): string | null {
  return namespace && namespace.length > 0 ? namespace : null;
}

export function alertResourceKey(resource: AlertResourceRef): string {
  return resource.namespace
    ? `${resource.kind}:${resource.namespace}/${resource.name}`
    : `${resource.kind}:${resource.name}`;
}

export function alertFingerprint(ruleId: AlertRuleId, resource: AlertResourceRef): string {
  return `${ruleId}:${alertResourceKey(resource)}`;
}

export function restartSampleKey(workload: WorkloadSummary): string {
  return alertResourceKey({
    kind: "pod",
    namespace: namespaceOrNull(workload.namespace),
    name: workload.name,
  });
}

export function collectRestartCounts(workloads: WorkloadSummary[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const workload of workloads) {
    if (workload.kind !== "pod") continue;
    const restarts = workload.restart_count ?? 0;
    counts[restartSampleKey(workload)] = restarts;
  }
  return counts;
}

function resourceFromWorkload(workload: WorkloadSummary): AlertResourceRef {
  return {
    kind: workload.kind,
    namespace: namespaceOrNull(workload.namespace),
    name: workload.name,
  };
}

function parseReady(ready: string): { ready: number; desired: number } | null {
  const match = ready.match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  const current = Number.parseInt(match[1], 10);
  const desired = Number.parseInt(match[2], 10);
  if (!Number.isFinite(current) || !Number.isFinite(desired)) return null;
  return { ready: current, desired };
}

function minutes(ms: number): number {
  return Math.max(0, Math.round(ms / 60_000));
}

function firstSeenFromAge(nowMs: number, ageSeconds: number): number {
  return nowMs - Math.max(0, ageSeconds) * 1_000;
}

function percent(used: number | null, total: number): number | null {
  if (used === null || total <= 0) return null;
  return Math.round((used / total) * 100);
}

function normalizeKind(kind: string | null | undefined): WorkloadKind | null {
  if (!kind) return null;
  const normalized = kind.replace(/\s+/g, "").replace(/_/g, "").toLowerCase();
  return KIND_ALIASES[normalized] ?? null;
}

function resourceFromEvent(event: AlertInboxEvent): AlertResourceRef | null {
  const directKind = normalizeKind(event.involved_kind ?? event.kind);
  if (directKind && event.involved_name) {
    return {
      kind: directKind,
      namespace: namespaceOrNull(event.namespace),
      name: event.involved_name,
    };
  }

  const involved = event.involved;
  if (!involved) return null;
  const slash = involved.indexOf("/");
  if (slash <= 0 || slash === involved.length - 1) return null;
  const kind = normalizeKind(involved.slice(0, slash));
  if (!kind) return null;
  return {
    kind,
    namespace: namespaceOrNull(event.namespace),
    name: involved.slice(slash + 1),
  };
}

function eventMs(event: AlertInboxEvent, fallbackMs: number): number {
  if (!event.ts) return fallbackMs;
  const parsed = Date.parse(event.ts);
  return Number.isNaN(parsed) ? fallbackMs : parsed;
}

function compareAlerts(a: AlertInboxItem, b: AlertInboxItem): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0) ||
    a.ruleId.localeCompare(b.ruleId) ||
    alertResourceKey(a.resource).localeCompare(alertResourceKey(b.resource))
  );
}

function deploymentAlert(workload: WorkloadSummary, nowMs: number): AlertInboxItem | null {
  if (workload.kind !== "deployment") return null;
  const ready = parseReady(workload.ready);
  const desired = ready?.desired ?? 0;
  const current = ready?.ready ?? 0;
  const unavailable = desired > 0 && current === 0;
  const degraded =
    desired > 0 && current < desired || workload.health === "degraded" || workload.health === "failed";
  if (!unavailable && !degraded) return null;

  const resource = resourceFromWorkload(workload);
  const ruleId: AlertRuleId = unavailable
    ? "deployment-unavailable"
    : "deployment-degraded";
  return {
    fingerprint: alertFingerprint(ruleId, resource),
    ruleId,
    severity: unavailable ? "critical" : "high",
    title: unavailable ? "Deployment unavailable" : "Deployment degraded",
    resource,
    evidence: [
      `health ${workload.health}`,
      `ready ${workload.ready}`,
      desired > 0 ? `${desired - current} unavailable replica${desired - current === 1 ? "" : "s"}` : "",
    ].filter(Boolean),
    nextChecks: [
      "Open the deployment and inspect rollout conditions",
      "Check owned pods for image, probe, scheduling, or config failures",
      "Review recent warning events before retrying the rollout",
    ],
    firstSeenMs: firstSeenFromAge(nowMs, workload.age_seconds),
    lastSeenMs: nowMs,
  };
}

function restartAlert(
  workload: WorkloadSummary,
  previousRestartCounts: Record<string, number>,
  nowMs: number,
): AlertInboxItem | null {
  if (workload.kind !== "pod") return null;
  const current = workload.restart_count ?? 0;
  const sampleKey = restartSampleKey(workload);
  const previous = previousRestartCounts[sampleKey];
  const delta = previous === undefined ? current : current - previous;
  if (current <= 0 || delta <= 0) return null;

  const resource = resourceFromWorkload(workload);
  const evidence = [
    previous === undefined
      ? `${current} total restart${current === 1 ? "" : "s"} observed`
      : `restarts increased by ${delta} since last sample`,
    `${current} total restart${current === 1 ? "" : "s"}`,
  ];
  if (workload.container_count !== undefined && workload.container_ready_count !== undefined) {
    evidence.push(`${workload.container_ready_count}/${workload.container_count} containers ready`);
  }
  if (workload.pod_phase) evidence.push(`phase ${workload.pod_phase}`);

  return {
    fingerprint: alertFingerprint("pod-restart-increase", resource),
    ruleId: "pod-restart-increase",
    severity: delta >= 5 || current >= 10 ? "critical" : "high",
    title: "Pod restart count increased",
    resource,
    evidence,
    nextChecks: [
      "Open logs for the restarting container",
      "Inspect warning events for BackOff, OOMKilled, or probe failures",
      "Compare recent config, image, secret, and resource-limit changes",
    ],
    firstSeenMs: firstSeenFromAge(nowMs, workload.age_seconds),
    lastSeenMs: nowMs,
  };
}

function pendingAlert(
  workload: WorkloadSummary,
  nowMs: number,
  thresholdMs: number,
): AlertInboxItem | null {
  if (workload.kind !== "pod" || workload.pod_phase !== "Pending") return null;
  const pendingMs = Math.max(0, workload.age_seconds * 1_000);
  if (pendingMs < thresholdMs) return null;
  const resource = resourceFromWorkload(workload);
  return {
    fingerprint: alertFingerprint("pod-pending-too-long", resource),
    ruleId: "pod-pending-too-long",
    severity: pendingMs >= 30 * 60_000 ? "medium" : "low",
    title: "Pod pending too long",
    resource,
    evidence: [
      `pending for ${minutes(pendingMs)}m`,
      `ready ${workload.ready}`,
      workload.node_name ? `node ${workload.node_name}` : "not scheduled",
    ],
    nextChecks: [
      "Open events for scheduling, pull, and volume binding reasons",
      "Compare requests against node allocatable CPU and memory",
      "Check taints, tolerations, affinity, and PVC status",
    ],
    firstSeenMs: firstSeenFromAge(nowMs, workload.age_seconds),
    lastSeenMs: nowMs,
  };
}

function failedJobAlert(workload: WorkloadSummary, nowMs: number): AlertInboxItem | null {
  if (workload.kind !== "job" || workload.health !== "failed") return null;
  const resource = resourceFromWorkload(workload);
  return {
    fingerprint: alertFingerprint("job-failed", resource),
    ruleId: "job-failed",
    severity: "high",
    title: "Job failed",
    resource,
    evidence: [`health ${workload.health}`, `ready ${workload.ready}`],
    nextChecks: [
      "Open the job and inspect completion/backoff settings",
      "Review pods and logs from the most recent failed run",
      "Check warning events for image, config, permission, or quota errors",
    ],
    firstSeenMs: firstSeenFromAge(nowMs, workload.age_seconds),
    lastSeenMs: nowMs,
  };
}

function nodeAlerts(node: NodeSummary, nowMs: number): AlertInboxItem[] {
  const resource: AlertResourceRef = { kind: "node", namespace: null, name: node.name };
  if (!node.ready) {
    return [
      {
        fingerprint: alertFingerprint("node-not-ready", resource),
        ruleId: "node-not-ready",
        severity: "critical",
        title: "Node not ready",
        resource,
        evidence: [
          "not ready",
          ...node.taints.map((taint) => `taint ${taint}`),
          node.unschedulable ? "cordoned" : "",
        ].filter(Boolean),
        nextChecks: [
          "Inspect node conditions and kubelet/runtime health",
          "Check disk, memory, network, and cloud provider events",
          "Cordon or drain if workloads are at risk",
        ],
        firstSeenMs: firstSeenFromAge(nowMs, node.age_seconds),
        lastSeenMs: nowMs,
      },
    ];
  }

  const taints = node.taints.filter((taint) => /pressure|not-ready|unreachable/i.test(taint));
  const cpuPct = percent(node.cpu_usage_milli, node.cpu_allocatable_milli);
  const memPct = percent(node.mem_usage_bytes, node.mem_allocatable_bytes);
  const pressure = taints.length > 0 || (cpuPct !== null && cpuPct >= 90) || (memPct !== null && memPct >= 90);
  if (!pressure) return [];
  const evidence = [
    ...taints.map((taint) => `taint ${taint}`),
    cpuPct !== null ? `cpu ${cpuPct}% of allocatable` : "",
    memPct !== null ? `memory ${memPct}% of allocatable` : "",
    node.unschedulable ? "cordoned" : "",
  ].filter(Boolean);

  return [
    {
      fingerprint: alertFingerprint("node-pressure", resource),
      ruleId: "node-pressure",
      severity: "high",
      title: "Node pressure detected",
      resource,
      evidence,
      nextChecks: [
        "Inspect node pressure conditions and eviction signals",
        "Find high request/usage pods on the node",
        "Consider scaling capacity or draining non-critical workloads",
      ],
      firstSeenMs: firstSeenFromAge(nowMs, node.age_seconds),
      lastSeenMs: nowMs,
    },
  ];
}

function warningSpikeAlerts(
  events: AlertInboxEvent[],
  nowMs: number,
  windowMs: number,
  threshold: number,
): AlertInboxItem[] {
  const buckets = new Map<string, { resource: AlertResourceRef; reason: string; events: AlertInboxEvent[] }>();
  const windowStart = nowMs - windowMs;

  for (const event of events) {
    if ((event.type_ ?? "").toLowerCase() !== "warning") continue;
    const ts = eventMs(event, nowMs);
    if (ts < windowStart || ts > nowMs + 1_000) continue;
    const resource = resourceFromEvent(event);
    if (!resource) continue;
    const reason = event.reason || "Warning";
    const key = `${alertResourceKey(resource)}:${reason}`;
    const bucket = buckets.get(key) ?? { resource, reason, events: [] };
    bucket.events.push(event);
    buckets.set(key, bucket);
  }

  const alerts: AlertInboxItem[] = [];
  for (const bucket of buckets.values()) {
    const count = bucket.events.reduce((total, event) => total + Math.max(1, event.count ?? 1), 0);
    if (count < threshold) continue;
    const times = bucket.events.map((event) => eventMs(event, nowMs)).sort((a, b) => a - b);
    const sample = bucket.events[0];
    alerts.push({
      fingerprint: `${alertFingerprint("warning-event-spike", bucket.resource)}:${bucket.reason}`,
      ruleId: "warning-event-spike",
      severity: count >= threshold * 2 ? "high" : "medium",
      title: `${bucket.reason} warning event spike`,
      resource: bucket.resource,
      evidence: [
        `${count} warning events in ${minutes(windowMs)}m`,
        `${bucket.reason}: ${sample.message ?? "No message"}`,
      ],
      nextChecks: [
        "Open events for the involved resource",
        "Correlate the spike with rollout, scheduling, or node changes",
        "Use logs when the warnings point at a pod or controller",
      ],
      firstSeenMs: times[0] ?? nowMs,
      lastSeenMs: times[times.length - 1] ?? nowMs,
      eventCount: count,
    });
  }
  return alerts;
}

function serviceExposureAlert(service: NetworkService, nowMs: number): AlertInboxItem | null {
  const serviceType = service.type ?? "ClusterIP";
  if (serviceType !== "LoadBalancer" && serviceType !== "NodePort") return null;
  const resource: AlertResourceRef = {
    kind: "service",
    namespace: namespaceOrNull(service.namespace),
    name: service.name,
  };
  const ports = service.ports.map((port) => port.port).join(", ");
  return {
    fingerprint: alertFingerprint("risky-service-exposure", resource),
    ruleId: "risky-service-exposure",
    severity: serviceType === "LoadBalancer" ? "medium" : "low",
    title: "Risky service exposure",
    resource,
    evidence: [
      `service type ${serviceType}`,
      ports ? `ports ${ports}` : "no service ports reported",
      Object.keys(service.selector).length > 0 ? "has pod selector" : "no pod selector",
    ],
    nextChecks: [
      "Confirm the exposure is intentional and protected",
      "Check ingress, firewall, allowlist, and network policy coverage",
      "Review backend pods before advertising public traffic",
    ],
    firstSeenMs: nowMs,
    lastSeenMs: nowMs,
  };
}

function dedupe(alerts: AlertInboxItem[]): AlertInboxItem[] {
  const byFingerprint = new Map<string, AlertInboxItem>();
  for (const alert of alerts) {
    const existing = byFingerprint.get(alert.fingerprint);
    if (!existing) {
      byFingerprint.set(alert.fingerprint, alert);
      continue;
    }
    byFingerprint.set(alert.fingerprint, {
      ...existing,
      evidence: Array.from(new Set([...existing.evidence, ...alert.evidence])),
      nextChecks: Array.from(new Set([...existing.nextChecks, ...alert.nextChecks])),
      firstSeenMs:
        existing.firstSeenMs === null
          ? alert.firstSeenMs
          : alert.firstSeenMs === null
            ? existing.firstSeenMs
            : Math.min(existing.firstSeenMs, alert.firstSeenMs),
      lastSeenMs:
        existing.lastSeenMs === null
          ? alert.lastSeenMs
          : alert.lastSeenMs === null
            ? existing.lastSeenMs
            : Math.max(existing.lastSeenMs, alert.lastSeenMs),
      eventCount: (existing.eventCount ?? 0) + (alert.eventCount ?? 0) || undefined,
    });
  }
  return Array.from(byFingerprint.values()).sort(compareAlerts);
}

export function buildAlertInbox(input: AlertInboxInput): AlertInboxItem[] {
  const nowMs = input.nowMs ?? Date.now();
  const pendingThresholdMs = input.pendingThresholdMs ?? DEFAULT_PENDING_THRESHOLD_MS;
  const warningSpikeWindowMs = input.warningSpikeWindowMs ?? DEFAULT_WARNING_SPIKE_WINDOW_MS;
  const warningSpikeThreshold = input.warningSpikeThreshold ?? DEFAULT_WARNING_SPIKE_THRESHOLD;
  const alerts: AlertInboxItem[] = [];

  for (const workload of input.workloads) {
    const failedJob = failedJobAlert(workload, nowMs);
    if (failedJob) {
      alerts.push(failedJob);
      continue;
    }

    const deployment = deploymentAlert(workload, nowMs);
    if (deployment) alerts.push(deployment);

    const restart = restartAlert(workload, input.previousRestartCounts ?? {}, nowMs);
    if (restart) alerts.push(restart);

    const pending = pendingAlert(workload, nowMs, pendingThresholdMs);
    if (pending) alerts.push(pending);
  }

  for (const node of input.nodes) {
    alerts.push(...nodeAlerts(node, nowMs));
  }

  alerts.push(
    ...warningSpikeAlerts(
      input.events ?? [],
      nowMs,
      warningSpikeWindowMs,
      warningSpikeThreshold,
    ),
  );

  for (const service of input.network?.services ?? []) {
    const alert = serviceExposureAlert(service, nowMs);
    if (alert) alerts.push(alert);
  }

  return dedupe(alerts);
}

export function summarizeAlertsBySeverity(
  alerts: AlertInboxItem[],
): Record<AlertSeverity, number> {
  return alerts.reduce<Record<AlertSeverity, number>>(
    (counts, alert) => {
      counts[alert.severity] += 1;
      return counts;
    },
    { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  );
}
