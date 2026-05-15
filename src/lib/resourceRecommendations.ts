import type { MetricsExplorerPod, MetricsExplorerSnapshot, PodDetails } from "@/lib/k8s";
import { formatCpu, formatMemory } from "@/lib/metricsExplorer";

export type ResourceRecommendationSignal =
  | "cpu-downsize"
  | "memory-risk"
  | "missing-request"
  | "missing-limit";

export type ResourceRecommendationConfidence = "high" | "medium" | "low";

export type ResourceRecommendation = {
  id: string;
  signal: ResourceRecommendationSignal;
  namespace: string;
  workloadKind: string;
  workloadName: string;
  podCount: number;
  samplePodName: string;
  currentCpuRequestMilli: number | null;
  recommendedCpuRequestMilli: number | null;
  currentMemoryRequestBytes: number | null;
  recommendedMemoryRequestBytes: number | null;
  cpuUsedMilli: number | null;
  memoryUsedBytes: number | null;
  reclaimableCpuMilli: number;
  confidence: ResourceRecommendationConfidence;
  supported: boolean;
  reason: string;
};

type WorkloadGroup = {
  namespace: string;
  workloadKind: string;
  workloadName: string;
  pods: MetricsExplorerPod[];
};

const SUPPORTED_PATCH_TARGETS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

function workloadKey(pod: MetricsExplorerPod): string {
  return `${pod.namespace}\u0000${pod.workload_kind}\u0000${pod.workload_name}`;
}

function groupPods(pods: MetricsExplorerPod[]): WorkloadGroup[] {
  const groups = new Map<string, MetricsExplorerPod[]>();
  for (const pod of pods) {
    groups.set(workloadKey(pod), [...(groups.get(workloadKey(pod)) ?? []), pod]);
  }
  return Array.from(groups.values()).map((pods) => {
    const first = pods[0];
    return {
      namespace: first.namespace,
      workloadKind: first.workload_kind,
      workloadName: first.workload_name,
      pods,
    };
  });
}

function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0);
}

function hasMissing(values: Array<number | null>): boolean {
  return values.some((value) => value === null);
}

function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function recommendationBase(
  group: WorkloadGroup,
  signal: ResourceRecommendationSignal,
): Omit<
  ResourceRecommendation,
  | "id"
  | "currentCpuRequestMilli"
  | "recommendedCpuRequestMilli"
  | "currentMemoryRequestBytes"
  | "recommendedMemoryRequestBytes"
  | "cpuUsedMilli"
  | "memoryUsedBytes"
  | "reclaimableCpuMilli"
  | "confidence"
  | "reason"
> {
  return {
    signal,
    namespace: group.namespace,
    workloadKind: group.workloadKind,
    workloadName: group.workloadName,
    podCount: group.pods.length,
    samplePodName: group.pods[0]?.name ?? "",
    supported: SUPPORTED_PATCH_TARGETS.has(group.workloadKind),
  };
}

function confidenceFor(group: WorkloadGroup, used: number | null): ResourceRecommendationConfidence {
  if (!SUPPORTED_PATCH_TARGETS.has(group.workloadKind)) return "low";
  if (used === null || used === 0) return "low";
  if (group.pods.length >= 2) return "medium";
  return "high";
}

function priority(signal: ResourceRecommendationSignal): number {
  if (signal === "cpu-downsize") return 0;
  if (signal === "memory-risk") return 1;
  if (signal === "missing-request") return 2;
  return 3;
}

function confidenceRank(confidence: ResourceRecommendationConfidence): number {
  if (confidence === "high") return 0;
  if (confidence === "medium") return 1;
  return 2;
}

function recommendationSort(a: ResourceRecommendation, b: ResourceRecommendation): number {
  return (
    Number(b.supported) - Number(a.supported) ||
    priority(a.signal) - priority(b.signal) ||
    confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
    b.reclaimableCpuMilli - a.reclaimableCpuMilli ||
    a.namespace.localeCompare(b.namespace) ||
    a.workloadName.localeCompare(b.workloadName)
  );
}

function recommendationId(rec: Omit<ResourceRecommendation, "id">): string {
  return [
    rec.signal,
    rec.namespace,
    rec.workloadKind,
    rec.workloadName,
  ].join(":");
}

export function recommendResourceChanges(snapshot: MetricsExplorerSnapshot): ResourceRecommendation[] {
  const recommendations: ResourceRecommendation[] = [];

  for (const group of groupPods(snapshot.pods)) {
    const cpuUsed = sumNullable(group.pods.map((pod) => pod.cpu_usage_milli));
    const cpuRequest = sumNullable(group.pods.map((pod) => pod.cpu_request_milli));
    const memoryUsed = sumNullable(group.pods.map((pod) => pod.mem_usage_bytes));
    const memoryRequest = sumNullable(group.pods.map((pod) => pod.mem_request_bytes));
    const podCount = Math.max(group.pods.length, 1);
    const currentCpuPerPod = cpuRequest === null ? null : Math.round(cpuRequest / podCount);
    const usedCpuPerPod = cpuUsed === null ? null : cpuUsed / podCount;
    const currentMemoryPerPod = memoryRequest === null ? null : Math.round(memoryRequest / podCount);
    const usedMemoryPerPod = memoryUsed === null ? null : memoryUsed / podCount;
    const missingRequest =
      hasMissing(group.pods.map((pod) => pod.cpu_request_milli)) ||
      hasMissing(group.pods.map((pod) => pod.mem_request_bytes));

    if (!missingRequest && currentCpuPerPod !== null && usedCpuPerPod !== null) {
      const recommendedCpu = Math.max(50, ceilTo(usedCpuPerPod * 2, 10));
      const reclaimableCpu = Math.max(0, currentCpuPerPod - recommendedCpu);
      if (currentCpuPerPod >= recommendedCpu * 1.5 && reclaimableCpu >= 100) {
        const rec = {
          ...recommendationBase(group, "cpu-downsize"),
          currentCpuRequestMilli: currentCpuPerPod,
          recommendedCpuRequestMilli: recommendedCpu,
          currentMemoryRequestBytes: currentMemoryPerPod,
          recommendedMemoryRequestBytes: null,
          cpuUsedMilli: Math.round(usedCpuPerPod),
          memoryUsedBytes: usedMemoryPerPod === null ? null : Math.round(usedMemoryPerPod),
          reclaimableCpuMilli: reclaimableCpu * podCount,
          confidence: confidenceFor(group, cpuUsed),
          reason: `CPU request is ${formatCpu(currentCpuPerPod)} per pod while observed usage is ${formatCpu(Math.round(usedCpuPerPod))}.`,
        } satisfies Omit<ResourceRecommendation, "id">;
        recommendations.push({ ...rec, id: recommendationId(rec) });
      }
    }

    if (!missingRequest && currentMemoryPerPod !== null && usedMemoryPerPod !== null) {
      const recommendedMemory = ceilTo(usedMemoryPerPod * 1.25, 64 * 1024 * 1024);
      if (usedMemoryPerPod >= currentMemoryPerPod * 0.85 && recommendedMemory > currentMemoryPerPod) {
        const rec = {
          ...recommendationBase(group, "memory-risk"),
          currentCpuRequestMilli: currentCpuPerPod,
          recommendedCpuRequestMilli: null,
          currentMemoryRequestBytes: currentMemoryPerPod,
          recommendedMemoryRequestBytes: recommendedMemory,
          cpuUsedMilli: usedCpuPerPod === null ? null : Math.round(usedCpuPerPod),
          memoryUsedBytes: Math.round(usedMemoryPerPod),
          reclaimableCpuMilli: 0,
          confidence: confidenceFor(group, memoryUsed),
          reason: `Memory usage is ${formatMemory(Math.round(usedMemoryPerPod))} per pod against a ${formatMemory(currentMemoryPerPod)} request.`,
        } satisfies Omit<ResourceRecommendation, "id">;
        recommendations.push({ ...rec, id: recommendationId(rec) });
      }
    }

    if (missingRequest) {
      const rec = {
        ...recommendationBase(group, "missing-request"),
        currentCpuRequestMilli: currentCpuPerPod,
        recommendedCpuRequestMilli: usedCpuPerPod === null ? null : Math.max(50, ceilTo(usedCpuPerPod * 2, 10)),
        currentMemoryRequestBytes: currentMemoryPerPod,
        recommendedMemoryRequestBytes: usedMemoryPerPod === null ? null : ceilTo(usedMemoryPerPod * 1.25, 64 * 1024 * 1024),
        cpuUsedMilli: usedCpuPerPod === null ? null : Math.round(usedCpuPerPod),
        memoryUsedBytes: usedMemoryPerPod === null ? null : Math.round(usedMemoryPerPod),
        reclaimableCpuMilli: 0,
        confidence: "low",
        reason: "One or more pods are missing CPU or memory requests, so scheduler placement and autoscaling signals are less reliable.",
      } satisfies Omit<ResourceRecommendation, "id">;
      recommendations.push({ ...rec, id: recommendationId(rec) });
    }

    if (
      hasMissing(group.pods.map((pod) => pod.cpu_limit_milli)) ||
      hasMissing(group.pods.map((pod) => pod.mem_limit_bytes))
    ) {
      const rec = {
        ...recommendationBase(group, "missing-limit"),
        currentCpuRequestMilli: currentCpuPerPod,
        recommendedCpuRequestMilli: null,
        currentMemoryRequestBytes: currentMemoryPerPod,
        recommendedMemoryRequestBytes: null,
        cpuUsedMilli: usedCpuPerPod === null ? null : Math.round(usedCpuPerPod),
        memoryUsedBytes: usedMemoryPerPod === null ? null : Math.round(usedMemoryPerPod),
        reclaimableCpuMilli: 0,
        confidence: "low",
        reason: "One or more pods are missing CPU or memory limits; add limits only where they match your workload policy.",
      } satisfies Omit<ResourceRecommendation, "id">;
      recommendations.push({ ...rec, id: recommendationId(rec) });
    }
  }

  return recommendations.sort(recommendationSort);
}

export function buildGitOpsPatch(
  recommendation: ResourceRecommendation,
  podDetails?: Pick<PodDetails, "containers"> | null,
): string {
  const containers = podDetails?.containers.length
    ? podDetails.containers.map((container) => container.name)
    : ["<container-name>"];
  const apiVersion = recommendation.workloadKind === "DaemonSet" ? "apps/v1" : "apps/v1";
  const resourceLines: string[] = [];
  if (recommendation.recommendedCpuRequestMilli !== null) {
    resourceLines.push(`              cpu: ${formatCpu(recommendation.recommendedCpuRequestMilli)}`);
  }
  if (recommendation.recommendedMemoryRequestBytes !== null) {
    resourceLines.push(`              memory: ${formatMemory(recommendation.recommendedMemoryRequestBytes)}`);
  }
  const resourcesBlock = resourceLines.length > 0
    ? resourceLines.join("\n")
    : "              # Add request or limit values that match your policy.";
  const containerBlocks = containers
    .map(
      (name) => `        - name: ${name}
          resources:
            requests:
${resourcesBlock}`,
    )
    .join("\n");

  return `# Lumen recommendation: ${recommendation.signal}
# Translate this patch into Helm values or Kustomize overlays before merging through GitOps.
apiVersion: ${apiVersion}
kind: ${recommendation.workloadKind}
metadata:
  name: ${recommendation.workloadName}
  namespace: ${recommendation.namespace}
spec:
  template:
    spec:
      containers:
${containerBlocks}`;
}

export function buildRecommendationPrSummary(recommendation: ResourceRecommendation): string {
  const target = `${recommendation.namespace}/${recommendation.workloadKind}/${recommendation.workloadName}`;
  const lines = [
    `Resource recommendation for ${target}`,
    "",
    `Signal: ${recommendation.signal}`,
    `Confidence: ${recommendation.confidence}`,
    `Reason: ${recommendation.reason}`,
  ];

  if (recommendation.signal === "cpu-downsize") {
    lines.push(
      `Current CPU request: ${formatCpu(recommendation.currentCpuRequestMilli)}`,
      `Recommended CPU request: ${formatCpu(recommendation.recommendedCpuRequestMilli)}`,
      `potential CPU request reduction: ${formatCpu(recommendation.reclaimableCpuMilli)} across ${recommendation.podCount} pod${recommendation.podCount === 1 ? "" : "s"}.`,
    );
  }
  if (recommendation.signal === "memory-risk") {
    lines.push(
      `Current memory request: ${formatMemory(recommendation.currentMemoryRequestBytes)}`,
      `Recommended memory request: ${formatMemory(recommendation.recommendedMemoryRequestBytes)}`,
    );
  }

  lines.push(
    "",
    "Caveat: this is a GitOps review aid, not a guaranteed node count reduction. Actual savings depend on bin packing, daemonsets, PDBs, taints, topology spread, and cluster autoscaler behavior.",
  );

  return lines.join("\n");
}
