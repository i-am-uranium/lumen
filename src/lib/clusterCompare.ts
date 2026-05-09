import type { WorkloadKind, WorkloadSummary } from "./k8s";

export type ClusterCompareSeverity = "high" | "medium" | "low";

export type ClusterCompareCategory =
  | "missing"
  | "extra"
  | "status"
  | "image"
  | "replicas"
  | "restarts"
  | "config"
  | "helm"
  | "argocd";

export type ClusterCompareImage = {
  container: string;
  image: string;
};

export type ClusterCompareReplicas = {
  ready: number | null;
  desired: number | null;
};

export type ClusterCompareHelm = {
  release?: string | null;
  revision?: number | null;
  chart?: string | null;
  appVersion?: string | null;
  status?: string | null;
};

export type ClusterCompareArgo = {
  syncStatus?: string | null;
  healthStatus?: string | null;
  targetRevision?: string | null;
};

export type ClusterCompareResource = {
  kind: WorkloadKind | string;
  namespace: string;
  name: string;
  status?: string | null;
  ready?: string | null;
  replicas?: ClusterCompareReplicas | null;
  restartCount?: number | null;
  images?: ClusterCompareImage[];
  env?: Record<string, string | null | undefined>;
  configRefs?: string[];
  helm?: ClusterCompareHelm | null;
  argo?: ClusterCompareArgo | null;
};

export type ClusterCompareFilters = {
  kinds?: string[];
  search?: string;
  matchNamespace?: boolean;
};

export type ClusterCompareInput = {
  source: ClusterCompareResource[];
  target: ClusterCompareResource[];
  sourceLabel?: string;
  targetLabel?: string;
  filters?: ClusterCompareFilters;
};

export type ClusterCompareRow = {
  id: string;
  key: string;
  kind: string;
  namespace: string;
  targetNamespace: string | null;
  name: string;
  category: ClusterCompareCategory;
  severity: ClusterCompareSeverity;
  evidence: string;
  source: ClusterCompareResource | null;
  target: ClusterCompareResource | null;
};

export type ClusterCompareSummary = {
  rows: ClusterCompareRow[];
  counts: Record<ClusterCompareCategory, number>;
  compared: number;
};

const CATEGORIES: ClusterCompareCategory[] = [
  "missing",
  "extra",
  "status",
  "image",
  "replicas",
  "restarts",
  "config",
  "helm",
  "argocd",
];

const SEVERITY_RANK: Record<ClusterCompareSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const CATEGORY_RANK = CATEGORIES.reduce<Record<ClusterCompareCategory, number>>(
  (acc, category, index) => {
    acc[category] = index;
    return acc;
  },
  {} as Record<ClusterCompareCategory, number>,
);

function parseReady(value: string | null | undefined): ClusterCompareReplicas | null {
  const match = value?.match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  return {
    ready: Number.parseInt(match[1], 10),
    desired: Number.parseInt(match[2], 10),
  };
}

function normalizeKind(kind: string): string {
  return kind.trim().toLowerCase();
}

function matchKey(resource: ClusterCompareResource, matchNamespace: boolean): string {
  const parts = [normalizeKind(resource.kind), resource.name];
  if (matchNamespace) parts.splice(1, 0, resource.namespace);
  return parts.join("/");
}

function displayKey(resource: ClusterCompareResource, matchNamespace: boolean): string {
  const kind = normalizeKind(resource.kind);
  return matchNamespace
    ? `${kind}/${resource.namespace}/${resource.name}`
    : `${kind}/${resource.name}`;
}

function normalizeResource(resource: ClusterCompareResource): ClusterCompareResource {
  return {
    ...resource,
    kind: normalizeKind(resource.kind),
    replicas: resource.replicas ?? parseReady(resource.ready),
  };
}

function createCounts(): Record<ClusterCompareCategory, number> {
  return CATEGORIES.reduce<Record<ClusterCompareCategory, number>>((acc, category) => {
    acc[category] = 0;
    return acc;
  }, {} as Record<ClusterCompareCategory, number>);
}

function listMatches(resource: ClusterCompareResource, filters: ClusterCompareFilters): boolean {
  const kinds = filters.kinds?.map(normalizeKind).filter(Boolean) ?? [];
  if (kinds.length > 0 && !kinds.includes(normalizeKind(resource.kind))) {
    return false;
  }

  const q = filters.search?.trim().toLowerCase();
  if (!q) return true;
  return [
    resource.kind,
    resource.namespace,
    resource.name,
    resource.status,
    resource.ready,
    ...(resource.images ?? []).map((item) => item.image),
    ...(resource.configRefs ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(q));
}

function sameValue(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "missing";
  return String(value);
}

function hasUnhealthyStatus(value: string | null | undefined): boolean {
  const normalized = value?.toLowerCase() ?? "";
  return ["failed", "degraded", "outofsync", "missing"].some((token) =>
    normalized.includes(token),
  );
}

function imageMap(resource: ClusterCompareResource): Map<string, string> {
  return new Map(
    (resource.images ?? [])
      .map((item) => [item.container || "container", item.image] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sortedEnv(resource: ClusterCompareResource): Map<string, string | null> {
  const entries = Object.entries(resource.env ?? {}).map(
    ([key, value]) => [key, value ?? null] as const,
  );
  entries.sort(([left], [right]) => left.localeCompare(right));
  return new Map(entries);
}

function sortedRefs(resource: ClusterCompareResource): string[] {
  return [...(resource.configRefs ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function refsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function addRow(
  rows: ClusterCompareRow[],
  source: ClusterCompareResource | null,
  target: ClusterCompareResource | null,
  matchNamespaceForDisplay: boolean,
  category: ClusterCompareCategory,
  severity: ClusterCompareSeverity,
  evidence: string,
): void {
  const resource = source ?? target;
  if (!resource) return;
  const key = displayKey(resource, matchNamespaceForDisplay);
  rows.push({
    id: `${category}:${key}:${evidence}`,
    key,
    kind: normalizeKind(resource.kind),
    namespace: source?.namespace ?? target?.namespace ?? "",
    targetNamespace: target?.namespace ?? null,
    name: resource.name,
    category,
    severity,
    evidence,
    source,
    target,
  });
}

function compareImages(
  rows: ClusterCompareRow[],
  source: ClusterCompareResource,
  target: ClusterCompareResource,
  matchNamespaceForDisplay: boolean,
): void {
  const sourceImages = imageMap(source);
  const targetImages = imageMap(target);
  const containers = [...new Set([...sourceImages.keys(), ...targetImages.keys()])].sort();
  for (const container of containers) {
    const before = sourceImages.get(container) ?? null;
    const after = targetImages.get(container) ?? null;
    if (sameValue(before, after)) continue;
    addRow(
      rows,
      source,
      target,
      matchNamespaceForDisplay,
      "image",
      "high",
      `${container} image ${formatValue(before)} -> ${formatValue(after)}`,
    );
  }
}

function compareReplicas(
  rows: ClusterCompareRow[],
  source: ClusterCompareResource,
  target: ClusterCompareResource,
  matchNamespaceForDisplay: boolean,
): void {
  const before = source.replicas ?? parseReady(source.ready);
  const after = target.replicas ?? parseReady(target.ready);
  if (!before && !after) return;

  const evidence: string[] = [];
  if (!sameValue(before?.desired, after?.desired)) {
    evidence.push(
      `desired replicas ${formatValue(before?.desired)} -> ${formatValue(after?.desired)}`,
    );
  }
  if (!sameValue(before?.ready, after?.ready)) {
    evidence.push(
      `ready replicas ${formatValue(before?.ready)} -> ${formatValue(after?.ready)}`,
    );
  }
  if (evidence.length === 0) return;
  addRow(
    rows,
    source,
    target,
    matchNamespaceForDisplay,
    "replicas",
    "medium",
    evidence.join("; "),
  );
}

function compareConfig(
  rows: ClusterCompareRow[],
  source: ClusterCompareResource,
  target: ClusterCompareResource,
  matchNamespaceForDisplay: boolean,
): void {
  const sourceEnv = sortedEnv(source);
  const targetEnv = sortedEnv(target);
  const envKeys = [...new Set([...sourceEnv.keys(), ...targetEnv.keys()])].sort();
  for (const key of envKeys) {
    const before = sourceEnv.get(key) ?? null;
    const after = targetEnv.get(key) ?? null;
    if (sameValue(before, after)) continue;
    addRow(
      rows,
      source,
      target,
      matchNamespaceForDisplay,
      "config",
      "high",
      `env ${key} ${formatValue(before)} -> ${formatValue(after)}`,
    );
  }

  const sourceRefs = sortedRefs(source);
  const targetRefs = sortedRefs(target);
  if (!refsEqual(sourceRefs, targetRefs)) {
    addRow(
      rows,
      source,
      target,
      matchNamespaceForDisplay,
      "config",
      "high",
      `config refs ${sourceRefs.join(", ") || "none"} -> ${targetRefs.join(", ") || "none"}`,
    );
  }
}

function compareHelm(
  rows: ClusterCompareRow[],
  source: ClusterCompareResource,
  target: ClusterCompareResource,
  matchNamespaceForDisplay: boolean,
): void {
  if (!source.helm && !target.helm) return;
  const evidence: string[] = [];
  if (!sameValue(source.helm?.status, target.helm?.status)) {
    evidence.push(
      `Helm status ${formatValue(source.helm?.status)} -> ${formatValue(target.helm?.status)}`,
    );
  }
  if (!sameValue(source.helm?.chart, target.helm?.chart)) {
    evidence.push(
      `chart ${formatValue(source.helm?.chart)} -> ${formatValue(target.helm?.chart)}`,
    );
  }
  if (!sameValue(source.helm?.appVersion, target.helm?.appVersion)) {
    evidence.push(
      `app ${formatValue(source.helm?.appVersion)} -> ${formatValue(target.helm?.appVersion)}`,
    );
  }
  if (!sameValue(source.helm?.revision, target.helm?.revision)) {
    evidence.push(
      `revision ${formatValue(source.helm?.revision)} -> ${formatValue(target.helm?.revision)}`,
    );
  }
  if (evidence.length === 0) return;
  addRow(rows, source, target, matchNamespaceForDisplay, "helm", "high", evidence.join("; "));
}

function compareArgo(
  rows: ClusterCompareRow[],
  source: ClusterCompareResource,
  target: ClusterCompareResource,
  matchNamespaceForDisplay: boolean,
): void {
  if (!source.argo && !target.argo) return;
  const evidence: string[] = [];
  if (!sameValue(source.argo?.syncStatus, target.argo?.syncStatus)) {
    evidence.push(
      `ArgoCD sync ${formatValue(source.argo?.syncStatus)} -> ${formatValue(target.argo?.syncStatus)}`,
    );
  }
  if (!sameValue(source.argo?.healthStatus, target.argo?.healthStatus)) {
    evidence.push(
      `health ${formatValue(source.argo?.healthStatus)} -> ${formatValue(target.argo?.healthStatus)}`,
    );
  }
  if (!sameValue(source.argo?.targetRevision, target.argo?.targetRevision)) {
    evidence.push(
      `revision ${formatValue(source.argo?.targetRevision)} -> ${formatValue(target.argo?.targetRevision)}`,
    );
  }
  if (evidence.length === 0) return;
  const severity =
    hasUnhealthyStatus(target.argo?.syncStatus) || hasUnhealthyStatus(target.argo?.healthStatus)
      ? "high"
      : "medium";
  addRow(rows, source, target, matchNamespaceForDisplay, "argocd", severity, evidence.join("; "));
}

function comparePair(
  rows: ClusterCompareRow[],
  source: ClusterCompareResource,
  target: ClusterCompareResource,
  matchNamespaceForDisplay: boolean,
): void {
  if (!sameValue(source.status, target.status)) {
    addRow(
      rows,
      source,
      target,
      matchNamespaceForDisplay,
      "status",
      hasUnhealthyStatus(target.status) ? "high" : "medium",
      `status ${formatValue(source.status)} -> ${formatValue(target.status)}`,
    );
  }

  compareImages(rows, source, target, matchNamespaceForDisplay);
  compareReplicas(rows, source, target, matchNamespaceForDisplay);

  if (!sameValue(source.restartCount, target.restartCount)) {
    addRow(
      rows,
      source,
      target,
      matchNamespaceForDisplay,
      "restarts",
      "medium",
      `restart count ${formatValue(source.restartCount)} -> ${formatValue(target.restartCount)}`,
    );
  }

  compareConfig(rows, source, target, matchNamespaceForDisplay);
  compareHelm(rows, source, target, matchNamespaceForDisplay);
  compareArgo(rows, source, target, matchNamespaceForDisplay);
}

export function resourceFromWorkloadSummary(
  summary: WorkloadSummary,
): ClusterCompareResource {
  return normalizeResource({
    kind: summary.kind,
    namespace: summary.namespace,
    name: summary.name,
    status: summary.pod_phase ?? summary.health,
    ready: summary.ready,
    restartCount: summary.restart_count ?? 0,
  });
}

export function compareClusterResources(input: ClusterCompareInput): ClusterCompareSummary {
  const filters = input.filters ?? {};
  const matchNamespace = filters.matchNamespace ?? true;
  const sourceLabel = input.sourceLabel ?? "source";
  const targetLabel = input.targetLabel ?? "target";
  const source = input.source.map(normalizeResource);
  const target = input.target.map(normalizeResource);
  const rows: ClusterCompareRow[] = [];
  const sourceMap = new Map<string, ClusterCompareResource>();
  const targetMap = new Map<string, ClusterCompareResource>();

  for (const resource of source) {
    if (listMatches(resource, filters)) sourceMap.set(matchKey(resource, matchNamespace), resource);
  }
  for (const resource of target) {
    if (listMatches(resource, filters)) targetMap.set(matchKey(resource, matchNamespace), resource);
  }

  const keys = [...new Set([...sourceMap.keys(), ...targetMap.keys()])].sort();
  for (const key of keys) {
    const sourceResource = sourceMap.get(key) ?? null;
    const targetResource = targetMap.get(key) ?? null;
    if (sourceResource && !targetResource) {
      addRow(
        rows,
        sourceResource,
        null,
        matchNamespace,
        "missing",
        "high",
        `present in ${sourceLabel}, missing in ${targetLabel}`,
      );
      continue;
    }
    if (!sourceResource && targetResource) {
      addRow(
        rows,
        null,
        targetResource,
        matchNamespace,
        "extra",
        "medium",
        `missing in ${sourceLabel}, present in ${targetLabel}`,
      );
      continue;
    }
    if (sourceResource && targetResource) {
      comparePair(rows, sourceResource, targetResource, matchNamespace);
    }
  }

  rows.sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
      CATEGORY_RANK[left.category] - CATEGORY_RANK[right.category] ||
      left.key.localeCompare(right.key) ||
      left.evidence.localeCompare(right.evidence),
  );

  const counts = createCounts();
  for (const row of rows) counts[row.category] += 1;
  return {
    rows,
    counts,
    compared: keys.length,
  };
}
