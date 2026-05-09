import type {
  MetricsExplorerNode,
  MetricsExplorerPod,
  MetricsExplorerSnapshot,
} from "@/lib/k8s";

export type Pressure = "unknown" | "low" | "medium" | "high" | "critical";
export type MetricsDataState = "empty" | "ready" | "partial" | "metrics-unavailable";

export type MetricRollup = {
  used: number;
  requested: number;
  limit: number;
  allocatable: number;
  usedPercent: number | null;
  requestPercent: number | null;
  pressure: Pressure;
};

export type CapacityRollup = {
  cpu: MetricRollup;
  memory: MetricRollup;
};

export type NamespaceRollup = CapacityRollup & {
  namespace: string;
  podCount: number;
};

export type WorkloadRollup = CapacityRollup & {
  namespace: string;
  kind: string;
  name: string;
  podCount: number;
};

export type NodePressure = MetricsExplorerNode & {
  cpuPercent: number | null;
  memoryPercent: number | null;
  cpuPressure: Pressure;
  memoryPressure: Pressure;
};

export type MetricsExplorerSummary = {
  cluster: CapacityRollup;
  namespaces: NamespaceRollup[];
  workloads: WorkloadRollup[];
  filteredPods: MetricsExplorerPod[];
  topPodsByCpu: MetricsExplorerPod[];
  topPodsByMemory: MetricsExplorerPod[];
  topWorkloadsByCpu: WorkloadRollup[];
  topWorkloadsByMemory: WorkloadRollup[];
  nodesByCpuPressure: NodePressure[];
  nodesByMemoryPressure: NodePressure[];
  dataState: MetricsDataState;
  errors: string[];
};

export type MetricsExplorerOptions = {
  namespace?: string;
  search?: string;
  limit?: number;
};

const CPU_SUFFIXES: Array<[string, number]> = [
  ["n", 1 / 1_000_000],
  ["u", 1 / 1_000],
  ["m", 1],
];

const MEMORY_SUFFIXES: Array<[string, number]> = [
  ["Ki", 1024],
  ["Mi", 1024 ** 2],
  ["Gi", 1024 ** 3],
  ["Ti", 1024 ** 4],
  ["Pi", 1024 ** 5],
  ["K", 1_000],
  ["M", 1_000_000],
  ["G", 1_000_000_000],
  ["T", 1_000_000_000_000],
  ["P", 1_000_000_000_000_000],
];

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function parseCpuQuantity(value: string): number | null {
  const input = value.trim();
  for (const [suffix, multiplier] of CPU_SUFFIXES) {
    if (input.endsWith(suffix)) {
      const parsed = Number(input.slice(0, -suffix.length));
      return finiteOrNull(Math.round(parsed * multiplier));
    }
  }
  const cores = Number(input);
  return finiteOrNull(Math.round(cores * 1000));
}

export function parseMemoryQuantity(value: string): number | null {
  const input = value.trim();
  for (const [suffix, multiplier] of MEMORY_SUFFIXES) {
    if (input.endsWith(suffix)) {
      const parsed = Number(input.slice(0, -suffix.length));
      return finiteOrNull(Math.round(parsed * multiplier));
    }
  }
  const parsed = Number(input);
  return finiteOrNull(Math.round(parsed));
}

export function utilizationPercent(value: number | null, total: number): number | null {
  if (value === null || total <= 0) return null;
  return (value / total) * 100;
}

export function classifyPressure(percent: number | null): Pressure {
  if (percent === null) return "unknown";
  if (percent >= 90) return "critical";
  if (percent >= 85) return "high";
  if (percent >= 70) return "medium";
  return "low";
}

export function formatCpu(value: number | null): string {
  if (value === null) return "-";
  if (Math.abs(value) < 1000) return `${Math.round(value)}m`;
  return `${formatNumber(value / 1000, 2)} cores`;
}

export function formatMemory(value: number | null): string {
  if (value === null) return "-";
  const abs = Math.abs(value);
  if (abs >= 1024 ** 4) return `${formatNumber(value / 1024 ** 4, 2)} TiB`;
  if (abs >= 1024 ** 3) return `${formatNumber(value / 1024 ** 3, 2)} GiB`;
  if (abs >= 1024 ** 2) return `${formatNumber(value / 1024 ** 2, 1)} MiB`;
  if (abs >= 1024) return `${formatNumber(value / 1024, 1)} KiB`;
  return `${Math.round(value)} B`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "-" : `${Math.round(value)}%`;
}

function formatNumber(value: number, maxFractionDigits: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: maxFractionDigits,
  }).format(value);
}

function metricRollup({
  used,
  requested,
  limit,
  allocatable,
}: {
  used: number;
  requested: number;
  limit: number;
  allocatable: number;
}): MetricRollup {
  const usedPercent = utilizationPercent(used, allocatable);
  return {
    used,
    requested,
    limit,
    allocatable,
    usedPercent,
    requestPercent: utilizationPercent(requested, allocatable),
    pressure: classifyPressure(usedPercent),
  };
}

function emptyRollup(): CapacityRollup {
  return {
    cpu: metricRollup({ used: 0, requested: 0, limit: 0, allocatable: 0 }),
    memory: metricRollup({ used: 0, requested: 0, limit: 0, allocatable: 0 }),
  };
}

function podMatches(pod: MetricsExplorerPod, namespace: string, query: string): boolean {
  if (namespace && pod.namespace !== namespace) return false;
  if (!query) return true;
  return [
    pod.namespace,
    pod.name,
    pod.node_name ?? "",
    pod.workload_kind,
    pod.workload_name,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function rollupPods(
  pods: MetricsExplorerPod[],
  allocatable: Pick<CapacityRollup, "cpu" | "memory">,
): CapacityRollup {
  let cpuUsed = 0;
  let cpuRequested = 0;
  let cpuLimit = 0;
  let memUsed = 0;
  let memRequested = 0;
  let memLimit = 0;

  for (const pod of pods) {
    cpuUsed += pod.cpu_usage_milli ?? 0;
    cpuRequested += pod.cpu_request_milli ?? 0;
    cpuLimit += pod.cpu_limit_milli ?? 0;
    memUsed += pod.mem_usage_bytes ?? 0;
    memRequested += pod.mem_request_bytes ?? 0;
    memLimit += pod.mem_limit_bytes ?? 0;
  }

  return {
    cpu: metricRollup({
      used: cpuUsed,
      requested: cpuRequested,
      limit: cpuLimit,
      allocatable: allocatable.cpu.allocatable,
    }),
    memory: metricRollup({
      used: memUsed,
      requested: memRequested,
      limit: memLimit,
      allocatable: allocatable.memory.allocatable,
    }),
  };
}

function workloadKey(pod: MetricsExplorerPod): string {
  return `${pod.namespace}\u0000${pod.workload_kind}\u0000${pod.workload_name}`;
}

function metricSortValue(
  row: {
    cpu?: MetricRollup;
    memory?: MetricRollup;
    cpu_usage_milli?: number | null;
    mem_usage_bytes?: number | null;
    cpu_request_milli?: number | null;
    mem_request_bytes?: number | null;
  },
  key: "cpu" | "memory",
): number {
  if (key === "cpu") {
    return row.cpu?.used || row.cpu?.requested || row.cpu_usage_milli || row.cpu_request_milli || 0;
  }
  return row.memory?.used || row.memory?.requested || row.mem_usage_bytes || row.mem_request_bytes || 0;
}

function byMetricDesc<T>(key: "cpu" | "memory") {
  return (a: T, b: T) =>
    metricSortValue(b as Parameters<typeof metricSortValue>[0], key) -
    metricSortValue(a as Parameters<typeof metricSortValue>[0], key);
}

function byPodUsageDesc(key: "cpu" | "memory") {
  return (a: MetricsExplorerPod, b: MetricsExplorerPod) => {
    const bValue = key === "cpu" ? b.cpu_usage_milli : b.mem_usage_bytes;
    const aValue = key === "cpu" ? a.cpu_usage_milli : a.mem_usage_bytes;
    return (bValue ?? -1) - (aValue ?? -1);
  };
}

function nodePressure(node: MetricsExplorerNode): NodePressure {
  const cpuPercent = utilizationPercent(node.cpu_usage_milli, node.cpu_allocatable_milli);
  const memoryPercent = utilizationPercent(
    node.mem_usage_bytes,
    node.mem_allocatable_bytes,
  );
  return {
    ...node,
    cpuPercent,
    memoryPercent,
    cpuPressure: classifyPressure(cpuPercent),
    memoryPressure: classifyPressure(memoryPercent),
  };
}

function dataState(snapshot: MetricsExplorerSnapshot): MetricsDataState {
  if (snapshot.nodes.length === 0 && snapshot.pods.length === 0) return "empty";
  const usageValues = [
    ...snapshot.nodes.flatMap((node) => [node.cpu_usage_milli, node.mem_usage_bytes]),
    ...snapshot.pods.flatMap((pod) => [pod.cpu_usage_milli, pod.mem_usage_bytes]),
  ];
  const hasUsage = usageValues.some((value) => value !== null);
  if (!hasUsage) return "metrics-unavailable";
  if (snapshot.errors.length > 0) return "partial";
  return "ready";
}

export function summarizeMetricsExplorer(
  snapshot: MetricsExplorerSnapshot,
  options: MetricsExplorerOptions = {},
): MetricsExplorerSummary {
  const namespace = options.namespace ?? "";
  const search = (options.search ?? "").trim().toLowerCase();
  const limit = options.limit ?? 8;
  const filteredPods = snapshot.pods.filter((pod) => podMatches(pod, namespace, search));
  const allocatable = emptyRollup();
  allocatable.cpu.allocatable = snapshot.nodes.reduce(
    (sum, node) => sum + node.cpu_allocatable_milli,
    0,
  );
  allocatable.memory.allocatable = snapshot.nodes.reduce(
    (sum, node) => sum + node.mem_allocatable_bytes,
    0,
  );

  const podCluster = rollupPods(snapshot.pods, allocatable);
  const nodeCpuUsed = snapshot.nodes.reduce(
    (sum, node) => sum + (node.cpu_usage_milli ?? 0),
    0,
  );
  const nodeMemUsed = snapshot.nodes.reduce(
    (sum, node) => sum + (node.mem_usage_bytes ?? 0),
    0,
  );
  const cluster = {
    cpu: metricRollup({
      used: nodeCpuUsed || podCluster.cpu.used,
      requested: podCluster.cpu.requested,
      limit: podCluster.cpu.limit,
      allocatable: allocatable.cpu.allocatable,
    }),
    memory: metricRollup({
      used: nodeMemUsed || podCluster.memory.used,
      requested: podCluster.memory.requested,
      limit: podCluster.memory.limit,
      allocatable: allocatable.memory.allocatable,
    }),
  };
  const namespaceGroups = new Map<string, MetricsExplorerPod[]>();
  const workloadGroups = new Map<string, MetricsExplorerPod[]>();

  for (const pod of snapshot.pods) {
    namespaceGroups.set(pod.namespace, [...(namespaceGroups.get(pod.namespace) ?? []), pod]);
    const key = workloadKey(pod);
    workloadGroups.set(key, [...(workloadGroups.get(key) ?? []), pod]);
  }

  const namespaces = Array.from(namespaceGroups, ([namespace, pods]) => ({
    namespace,
    podCount: pods.length,
    ...rollupPods(pods, allocatable),
  })).sort((a, b) => a.namespace.localeCompare(b.namespace));

  const workloads = Array.from(workloadGroups, ([, pods]) => {
    const first = pods[0];
    return {
      namespace: first.namespace,
      kind: first.workload_kind,
      name: first.workload_name,
      podCount: pods.length,
      ...rollupPods(pods, allocatable),
    };
  });

  const nodes = snapshot.nodes.map(nodePressure);

  return {
    cluster,
    namespaces,
    workloads,
    filteredPods,
    topPodsByCpu: [...filteredPods]
      .filter((pod) => pod.cpu_usage_milli !== null)
      .sort(byPodUsageDesc("cpu"))
      .slice(0, limit),
    topPodsByMemory: [...filteredPods]
      .filter((pod) => pod.mem_usage_bytes !== null)
      .sort(byPodUsageDesc("memory"))
      .slice(0, limit),
    topWorkloadsByCpu: [...workloads].sort(byMetricDesc("cpu")).slice(0, limit),
    topWorkloadsByMemory: [...workloads].sort(byMetricDesc("memory")).slice(0, limit),
    nodesByCpuPressure: [...nodes].sort(
      (a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1),
    ),
    nodesByMemoryPressure: [...nodes].sort(
      (a, b) => (b.memoryPercent ?? -1) - (a.memoryPercent ?? -1),
    ),
    dataState: dataState(snapshot),
    errors: snapshot.errors,
  };
}
