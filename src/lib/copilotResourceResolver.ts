import { k8s, type Health, type WorkloadKind, type WorkloadSummary } from "@/lib/k8s";
import type { CopilotIntentKind } from "./copilotIntent";

export type CopilotResourceSource = "kubernetes" | "argocd" | "helm";

export type CopilotResolvedResource = {
  id: string;
  kind: WorkloadKind | "argocdapplication" | "helmrelease";
  namespace: string;
  name: string;
  displayName: string;
  source: CopilotResourceSource;
  score: number;
  reasons: string[];
  health: Health;
  ready?: string;
};

export type CopilotResolveStatus = "resolved" | "ambiguous" | "not_found";

export type CopilotResolveRequest = {
  context: string;
  query: string;
  namespace?: string;
  intent?: CopilotIntentKind;
  kinds?: WorkloadKind[];
};

export type CopilotResolveResult = {
  status: CopilotResolveStatus;
  query: string;
  normalizedQuery: string;
  searchedKinds: string[];
  candidates: CopilotResolvedResource[];
  selected: CopilotResolvedResource | null;
};

export type CopilotResolverClient = {
  listWorkloads: (
    namespace: string,
    kind: WorkloadKind,
    context?: string,
  ) => Promise<WorkloadSummary[]>;
  listArgocdApplications?: (context?: string, namespace?: string) => Promise<unknown[]>;
  listHelmReleases?: (context?: string) => Promise<unknown[]>;
};

const DEFAULT_KINDS: WorkloadKind[] = [
  "deployment",
  "pod",
  "service",
  "ingress",
  "statefulset",
  "daemonset",
  "job",
];

const SCORE_THRESHOLD = 50;
const RESOLVED_THRESHOLD = 90;
const NAMESPACE_BONUS = 15;

const defaultClient: CopilotResolverClient = {
  listWorkloads: (namespace, kind, context) =>
    k8s.listWorkloads(namespace, kind, context),
};

export function normalizeCopilotResourcePhrase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function scoreCopilotCandidate(
  query: string,
  workload: WorkloadSummary,
): { score: number; reasons: string[] } {
  const normalizedQuery = normalizeCopilotResourcePhrase(query);
  const normalizedName = normalizeCopilotResourcePhrase(workload.name);
  const reasons: string[] = [];
  let score = 0;

  if (!normalizedQuery) {
    return { score, reasons };
  }

  if (normalizedName === normalizedQuery) {
    score = 100;
    reasons.push("exact normalized name match");
  } else if (workload.name.toLowerCase() === query.trim().toLowerCase()) {
    score = 95;
    reasons.push("exact display name match");
  } else if (normalizedName.startsWith(normalizedQuery)) {
    score = 80;
    reasons.push("name starts with query");
  } else if (normalizedName.includes(normalizedQuery)) {
    score = 60;
    reasons.push("name contains query");
  } else {
    const queryParts = normalizedQuery.split("-").filter(Boolean);
    const matchedParts = queryParts.filter((part) => normalizedName.includes(part));
    if (queryParts.length > 0 && matchedParts.length > 0) {
      score = Math.round((matchedParts.length / queryParts.length) * 45);
      reasons.push("partial token match");
    }
  }

  const labelName =
    workload.labels["app.kubernetes.io/name"] ??
    workload.labels.app ??
    workload.labels["app"];
  if (
    labelName &&
    normalizeCopilotResourcePhrase(labelName) === normalizedQuery
  ) {
    score += 10;
    reasons.push("matching app label");
  }

  return { score, reasons };
}

export async function resolveCopilotResource(
  request: CopilotResolveRequest,
  client: CopilotResolverClient = defaultClient,
): Promise<CopilotResolveResult> {
  const kinds = request.kinds ?? DEFAULT_KINDS;
  const namespace = request.namespace ?? "";
  const searchedKinds = kinds.map(String);
  const workloads = (
    await Promise.all(
      kinds.map((kind) => client.listWorkloads(namespace, kind, request.context)),
    )
  ).flat();

  const candidates = workloads
    .map((workload) => {
      const scored = scoreCopilotCandidate(request.query, workload);
      const namespaceScore =
        request.namespace && workload.namespace === request.namespace
          ? scored.score + NAMESPACE_BONUS
          : scored.score;
      return toResolvedResource(workload, namespaceScore, scored.reasons);
    })
    .filter((candidate) => candidate.score >= SCORE_THRESHOLD)
    .sort(compareCandidates);

  const selected = selectCandidate(candidates);

  return {
    status: selected
      ? "resolved"
      : candidates.length > 0
        ? "ambiguous"
        : "not_found",
    query: request.query,
    normalizedQuery: normalizeCopilotResourcePhrase(request.query),
    searchedKinds,
    candidates,
    selected,
  };
}

function toResolvedResource(
  workload: WorkloadSummary,
  score: number,
  reasons: string[],
): CopilotResolvedResource {
  return {
    id: `kubernetes:${workload.kind}:${workload.namespace}:${workload.name}`,
    kind: workload.kind,
    namespace: workload.namespace,
    name: workload.name,
    displayName: `${workload.kind}/${workload.namespace}/${workload.name}`,
    source: "kubernetes",
    score,
    reasons,
    health: workload.health,
    ready: workload.ready,
  };
}

function compareCandidates(a: CopilotResolvedResource, b: CopilotResolvedResource): number {
  return (
    b.score - a.score ||
    a.namespace.localeCompare(b.namespace) ||
    a.kind.localeCompare(b.kind) ||
    a.name.localeCompare(b.name)
  );
}

function selectCandidate(
  candidates: CopilotResolvedResource[],
): CopilotResolvedResource | null {
  const [first, second] = candidates;
  if (!first || first.score < RESOLVED_THRESHOLD) return null;
  if (!second) return first;
  if (first.score > second.score) return first;
  return null;
}
