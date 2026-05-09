import type { EventLine, EventSummary, NodeSummary, WorkloadKind, WorkloadSummary } from "@/lib/k8s";

export type TriageSeverity = "critical" | "high" | "medium" | "low";

export type TriageGroup =
  | "crashloop-restarts"
  | "pending-pods"
  | "failed-workloads"
  | "warning-events"
  | "node-health"
  | "degraded-controllers";

export type TriageResourceRef = {
  kind: WorkloadKind;
  namespace: string | null;
  name: string;
};

export type TriageIssue = {
  id: string;
  group: TriageGroup;
  severity: TriageSeverity;
  title: string;
  resource: TriageResourceRef;
  evidence: string[];
  nextActions: string[];
};

export type TriageEvent = Partial<EventLine & EventSummary> & {
  ts?: string | null;
  type_?: string;
  reason?: string;
  message?: string;
  involved?: string;
  involved_kind?: string;
  involved_name?: string;
  namespace?: string | null;
  count?: number | null;
};

export type TriageInput = {
  context: string;
  workloads: WorkloadSummary[];
  nodes: NodeSummary[];
  events?: TriageEvent[];
};

const SEVERITY_RANK: Record<TriageSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const KIND_LABELS: Partial<Record<WorkloadKind, string>> = {
  pod: "Pod",
  job: "Job",
  cronjob: "CronJob",
  deployment: "Deployment",
  statefulset: "StatefulSet",
  daemonset: "DaemonSet",
  replicaset: "ReplicaSet",
  replicationcontroller: "ReplicationController",
  node: "Node",
};

const WORKLOAD_KINDS = new Set<WorkloadKind>([
  "pod",
  "deployment",
  "statefulset",
  "daemonset",
  "replicaset",
  "replicationcontroller",
  "cronjob",
  "job",
  "node",
]);

const CONTROLLER_KINDS = new Set<WorkloadKind>([
  "deployment",
  "statefulset",
  "daemonset",
  "replicaset",
  "replicationcontroller",
  "cronjob",
]);

function issueId(group: TriageGroup, resource: TriageResourceRef): string {
  return `${group}:${triageResourceKey(resource)}`;
}

export function triageResourceKey(resource: TriageResourceRef): string {
  return `${resource.kind}/${resource.namespace ?? ""}/${resource.name}`;
}

function kindLabel(kind: WorkloadKind): string {
  return KIND_LABELS[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}

function asEvidence(value: string | null | undefined): string[] {
  return value ? [value] : [];
}

function namespaceOrNull(namespace: string | null | undefined): string | null {
  return namespace && namespace.length > 0 ? namespace : null;
}

function workloadResource(workload: WorkloadSummary): TriageResourceRef {
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

function percent(used: number | null, total: number): number | null {
  if (used === null || total <= 0) return null;
  return Math.round((used / total) * 100);
}

function pressureTaints(node: NodeSummary): string[] {
  return node.taints.filter((taint) => /pressure|not-ready|unreachable/i.test(taint));
}

function normalizeKind(kind: string | null | undefined): WorkloadKind | null {
  if (!kind) return null;
  const normalized = kind
    .replace(/\s+/g, "")
    .replace(/_/g, "")
    .toLowerCase();
  const aliases: Record<string, WorkloadKind> = {
    pods: "pod",
    pod: "pod",
    deployments: "deployment",
    deployment: "deployment",
    statefulsets: "statefulset",
    statefulset: "statefulset",
    daemonsets: "daemonset",
    daemonset: "daemonset",
    replicasets: "replicaset",
    replicaset: "replicaset",
    replicationcontrollers: "replicationcontroller",
    replicationcontroller: "replicationcontroller",
    cronjobs: "cronjob",
    cronjob: "cronjob",
    jobs: "job",
    job: "job",
    nodes: "node",
    node: "node",
  };
  return aliases[normalized] ?? (WORKLOAD_KINDS.has(normalized as WorkloadKind) ? normalized as WorkloadKind : null);
}

function involvedResource(event: TriageEvent): TriageResourceRef | null {
  const fromFieldsKind = normalizeKind(event.involved_kind ?? event.kind);
  if (fromFieldsKind && event.involved_name) {
    return {
      kind: fromFieldsKind,
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

function compareIssues(a: TriageIssue, b: TriageIssue): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.group.localeCompare(b.group) ||
    (a.resource.namespace ?? "").localeCompare(b.resource.namespace ?? "") ||
    a.resource.kind.localeCompare(b.resource.kind) ||
    a.resource.name.localeCompare(b.resource.name)
  );
}

function restartIssue(workload: WorkloadSummary): TriageIssue | null {
  if (workload.kind !== "pod") return null;
  const restarts = workload.restart_count ?? 0;
  if (restarts <= 0) return null;

  const evidence = [
    `${restarts} container restart${restarts === 1 ? "" : "s"}`,
    ...asEvidence(workload.ready ? `ready ${workload.ready}` : null),
    ...asEvidence(workload.pod_phase ? `phase ${workload.pod_phase}` : null),
  ];
  if (workload.container_count !== undefined && workload.container_ready_count !== undefined) {
    evidence.push(`${workload.container_ready_count}/${workload.container_count} containers ready`);
  }
  if (workload.node_name) evidence.push(`scheduled on ${workload.node_name}`);

  const resource = workloadResource(workload);
  return {
    id: issueId("crashloop-restarts", resource),
    group: "crashloop-restarts",
    severity: restarts >= 10 ? "critical" : "high",
    title: "Pod restarting repeatedly",
    resource,
    evidence,
    nextActions: [
      "Open logs for the failing container",
      "Check recent warning events for BackOff, OOMKilled, or probe failures",
      "Inspect resource limits, probes, config, and rollout history",
    ],
  };
}

function pendingIssue(workload: WorkloadSummary): TriageIssue | null {
  if (workload.kind !== "pod" || workload.pod_phase !== "Pending") return null;
  const resource = workloadResource(workload);
  return {
    id: issueId("pending-pods", resource),
    group: "pending-pods",
    severity: "medium",
    title: "Pod pending",
    resource,
    evidence: [
      ...asEvidence(workload.ready ? `ready ${workload.ready}` : null),
      "phase Pending",
      ...asEvidence(workload.node_name ? `node ${workload.node_name}` : "not scheduled"),
    ],
    nextActions: [
      "Check scheduling events and PVC bindings",
      "Compare requests against node allocatable CPU and memory",
      "Look for taints, tolerations, affinity, and image pull errors",
    ],
  };
}

function failedIssue(workload: WorkloadSummary): TriageIssue | null {
  const failedPod = workload.kind === "pod" && (workload.pod_phase === "Failed" || workload.health === "failed");
  const failedJob = workload.kind === "job" && workload.health === "failed";
  if (!failedPod && !failedJob) return null;
  const resource = workloadResource(workload);
  return {
    id: issueId("failed-workloads", resource),
    group: "failed-workloads",
    severity: "high",
    title: `${kindLabel(workload.kind)} failed`,
    resource,
    evidence: [
      `health ${workload.health}`,
      ...asEvidence(workload.ready ? `ready ${workload.ready}` : null),
      ...asEvidence(workload.pod_phase ? `phase ${workload.pod_phase}` : null),
      ...asEvidence((workload.restart_count ?? 0) > 0 ? `${workload.restart_count} restarts` : null),
    ],
    nextActions: [
      "Open events for failure reason and last transition",
      "Inspect logs from the most recent failed pod",
      "Check owner controller status and retry/backoff policy",
    ],
  };
}

function degradedControllerIssue(workload: WorkloadSummary): TriageIssue | null {
  if (!CONTROLLER_KINDS.has(workload.kind)) return null;
  const ready = parseReady(workload.ready);
  const desiredMismatch = ready !== null && ready.ready < ready.desired;
  if (workload.health === "healthy" && !desiredMismatch) return null;
  if (workload.health === "failed") return null;

  const resource = workloadResource(workload);
  return {
    id: issueId("degraded-controllers", resource),
    group: "degraded-controllers",
    severity: "medium",
    title: `${kindLabel(workload.kind)} degraded`,
    resource,
    evidence: [
      `health ${workload.health}`,
      ...asEvidence(workload.ready ? `ready ${workload.ready}` : null),
    ],
    nextActions: [
      "Open owned pods and compare desired vs ready replicas",
      "Check rollout conditions and recent warning events",
      "Review image, config, probes, and scheduling constraints",
    ],
  };
}

function nodeIssue(node: NodeSummary): TriageIssue | null {
  const taints = pressureTaints(node);
  const cpuPct = percent(node.cpu_usage_milli, node.cpu_allocatable_milli);
  const memPct = percent(node.mem_usage_bytes, node.mem_allocatable_bytes);
  const cpuPressure = cpuPct !== null && cpuPct >= 90;
  const memPressure = memPct !== null && memPct >= 90;
  if (node.ready && taints.length === 0 && !cpuPressure && !memPressure) return null;

  const resource: TriageResourceRef = { kind: "node", namespace: null, name: node.name };
  const evidence = [
    node.ready ? "ready" : "not ready",
    ...taints.map((taint) => `taint ${taint}`),
  ];
  if (cpuPct !== null) evidence.push(`cpu ${cpuPct}% of allocatable`);
  if (memPct !== null) evidence.push(`memory ${memPct}% of allocatable`);
  if (node.unschedulable) evidence.push("cordoned");

  return {
    id: issueId("node-health", resource),
    group: "node-health",
    severity: node.ready ? "high" : "critical",
    title: node.ready ? "Node pressure detected" : "Node not ready",
    resource,
    evidence,
    nextActions: [
      "Inspect node conditions and recent warning events",
      "Check kubelet, runtime, disk, memory, and network health",
      "Cordon or drain if workloads are at risk",
    ],
  };
}

function warningEventIssue(event: TriageEvent): TriageIssue | null {
  if (event.type_ !== "Warning") return null;
  const resource = involvedResource(event);
  if (!resource) return null;
  const reason = event.reason || "Warning";
  const count = event.count && event.count > 1 ? ` (x${event.count})` : "";
  return {
    id: issueId("warning-events", resource) + `:${reason}:${event.message ?? ""}`,
    group: "warning-events",
    severity: "medium",
    title: `${reason} warning event`,
    resource,
    evidence: [`${reason}${count}: ${event.message ?? "No message"}`],
    nextActions: [
      "Open events for the involved resource",
      "Correlate the timestamp with rollout, scheduling, or node changes",
      "Use logs when the event points at a pod or controller",
    ],
  };
}

export function buildTriageIssues(input: TriageInput): TriageIssue[] {
  const issues: TriageIssue[] = [];

  for (const workload of input.workloads) {
    const failed = failedIssue(workload);
    if (failed) {
      issues.push(failed);
      continue;
    }
    const restarted = restartIssue(workload);
    if (restarted) issues.push(restarted);

    const pending = pendingIssue(workload);
    if (pending) issues.push(pending);

    const degraded = degradedControllerIssue(workload);
    if (degraded) issues.push(degraded);
  }

  for (const node of input.nodes) {
    const issue = nodeIssue(node);
    if (issue) issues.push(issue);
  }

  for (const event of input.events ?? []) {
    const issue = warningEventIssue(event);
    if (issue) issues.push(issue);
  }

  return issues.sort(compareIssues);
}

export function triageIssueCountsBySeverity(
  issues: TriageIssue[],
): Record<TriageSeverity, number> {
  return issues.reduce<Record<TriageSeverity, number>>(
    (counts, issue) => {
      counts[issue.severity] += 1;
      return counts;
    },
    { critical: 0, high: 0, medium: 0, low: 0 },
  );
}
