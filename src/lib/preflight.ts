import type { WorkloadKind } from "@/lib/k8s";

export type PreflightActionType =
  | "apply"
  | "delete"
  | "restart"
  | "scale"
  | "set-image"
  | "trigger"
  | "helm-install"
  | "helm-upgrade"
  | "helm-uninstall"
  | "helm-rollback"
  | "argocd-sync"
  | "argocd-refresh"
  | "argocd-rollback"
  | "argocd-terminate";

export type PreflightRiskLevel = "low" | "medium" | "high";
export type PreflightDiffCategory =
  | "image"
  | "replicas"
  | "selector"
  | "probe"
  | "resources"
  | "service"
  | "ingress"
  | "network-policy"
  | "rbac"
  | "metadata"
  | "manifest";

export type PodChurnLevel = "none" | "low" | "medium" | "high";
export type ServiceRisk = "none" | "selector-or-port-change" | "possible-endpoint-change";

export type PreflightTarget = {
  kind: string;
  namespace?: string | null;
  name: string;
  replicas?: number | null;
  currentReplicas?: number | null;
};

export type PreflightWarning = {
  severity: PreflightRiskLevel;
  message: string;
};

export type PreflightDiff = {
  category: PreflightDiffCategory;
  severity: PreflightRiskLevel;
  label: string;
  before?: string;
  after?: string;
};

export type PreflightImpact = {
  actionType: PreflightActionType;
  targetLabel: string;
  namespace: string | null;
  affectedResourceCount: number;
  podChurn: {
    level: PodChurnLevel;
    estimatedPods: number | null;
    summary: string;
  };
  serviceRisk: ServiceRisk;
  riskLevel: PreflightRiskLevel;
  requiresExplicitConfirm: boolean;
  warnings: PreflightWarning[];
  diffs: PreflightDiff[];
};

type KubeYamlDoc = {
  kind: string;
  namespace: string | null;
  name: string;
  replicas: number | null;
  images: string[];
  selectorBlock: string;
  serviceSelectorBlock: string;
  servicePortsBlock: string;
  ingressRoutes: string[];
  probeNames: string[];
  resourcesBlocks: string[];
  networkPolicyBroad: boolean;
  rbacBroad: boolean;
  raw: string;
};

export function analyzeYamlPreflight({
  actionType,
  target,
  beforeYaml,
  afterYaml,
}: {
  actionType: Extract<PreflightActionType, "apply" | "delete">;
  target: PreflightTarget;
  beforeYaml?: string | null;
  afterYaml?: string | null;
}): PreflightImpact {
  const beforeDocs = parseKubeYamlDocs(beforeYaml ?? "");
  const afterDocs = parseKubeYamlDocs(afterYaml ?? "");
  const diffs: PreflightDiff[] = [];
  const warnings: PreflightWarning[] = [];
  const count = Math.max(afterDocs.length, beforeDocs.length, 1);

  for (let index = 0; index < count; index += 1) {
    const before = beforeDocs[index] ?? null;
    const after = afterDocs[index] ?? null;
    if (!before || !after) {
      diffs.push({
        category: "manifest",
        severity: "medium",
        label: before ? "manifest removed" : "manifest added",
        before: before?.kind,
        after: after?.kind,
      });
      continue;
    }

    if (!sameArray(before.images, after.images)) {
      diffs.push({
        category: "image",
        severity: "medium",
        label: "container image changed",
        before: before.images.join(", ") || "none",
        after: after.images.join(", ") || "none",
      });
    }

    if (before.replicas !== after.replicas) {
      diffs.push({
        category: "replicas",
        severity: after.replicas === 0 ? "high" : "medium",
        label: "replica count changed",
        before: formatMaybeNumber(before.replicas),
        after: formatMaybeNumber(after.replicas),
      });
    }

    if (before.selectorBlock && before.selectorBlock !== after.selectorBlock) {
      diffs.push({
        category: "selector",
        severity: "high",
        label: "selector changed",
        before: before.selectorBlock,
        after: after.selectorBlock || "none",
      });
      warnings.push({
        severity: "high",
        message: "Selector changed; existing pods or service endpoints may be orphaned or replaced.",
      });
    }

    const removedProbes = before.probeNames.filter(
      (probe) => !after.probeNames.includes(probe),
    );
    if (removedProbes.length > 0) {
      diffs.push({
        category: "probe",
        severity: "high",
        label: "readiness/liveness probe removed",
        before: removedProbes.join(", "),
        after: "removed",
      });
      warnings.push({
        severity: "high",
        message: "Readiness/liveness probe removed; traffic may reach unhealthy pods.",
      });
    }

    if (!sameArray(before.resourcesBlocks, after.resourcesBlocks)) {
      diffs.push({
        category: "resources",
        severity: "medium",
        label: "resource requests/limits changed",
        before: before.resourcesBlocks.join("\n---\n") || "none",
        after: after.resourcesBlocks.join("\n---\n") || "none",
      });
    }

    if (
      after.kind.toLowerCase() === "service" &&
      (before.serviceSelectorBlock !== after.serviceSelectorBlock ||
        before.servicePortsBlock !== after.servicePortsBlock)
    ) {
      diffs.push({
        category: "service",
        severity: "high",
        label: "Service selector or port changed",
        before: [before.serviceSelectorBlock, before.servicePortsBlock].filter(Boolean).join("\n"),
        after: [after.serviceSelectorBlock, after.servicePortsBlock].filter(Boolean).join("\n"),
      });
      warnings.push({
        severity: "high",
        message: "Service selector or port changed; endpoints or clients may be disrupted.",
      });
    }

    if (
      after.kind.toLowerCase() === "ingress" &&
      !sameArray(before.ingressRoutes, after.ingressRoutes)
    ) {
      diffs.push({
        category: "ingress",
        severity: "medium",
        label: "Ingress route changed",
        before: before.ingressRoutes.join(", ") || "none",
        after: after.ingressRoutes.join(", ") || "none",
      });
    }

    if (
      after.kind.toLowerCase() === "networkpolicy" &&
      !before.networkPolicyBroad &&
      after.networkPolicyBroad
    ) {
      diffs.push({
        category: "network-policy",
        severity: "high",
        label: "NetworkPolicy broadened",
        before: "restricted",
        after: "broader traffic scope",
      });
      warnings.push({
        severity: "high",
        message: "NetworkPolicy appears broader; more pods or peers may be allowed.",
      });
    }

    if (isRbacKind(after.kind) && !before.rbacBroad && after.rbacBroad) {
      diffs.push({
        category: "rbac",
        severity: "high",
        label: "RBAC permissions broadened",
        before: "restricted",
        after: "wildcard or write-capable rule",
      });
      warnings.push({
        severity: "high",
        message: "RBAC rule appears broader; review wildcard resources, groups, or verbs.",
      });
    }
  }

  const highest = highestRisk(diffs.map((diff) => diff.severity), warnings);
  const estimatedPods = estimateYamlPods(afterDocs, beforeDocs, target);
  const podChurn = podChurnFor(estimatedPods, diffs, actionType);
  const serviceRisk = diffs.some((diff) => diff.category === "service")
    ? "selector-or-port-change"
    : diffs.some((diff) => diff.category === "selector")
      ? "possible-endpoint-change"
      : "none";

  if (diffs.length === 0) {
    warnings.push({
      severity: "low",
      message: "No notable Kubernetes impact detected from the fields Lumen can inspect locally.",
    });
  }

  return {
    actionType,
    targetLabel: formatTargets([target]),
    namespace: target.namespace ?? afterDocs[0]?.namespace ?? beforeDocs[0]?.namespace ?? null,
    affectedResourceCount: count,
    podChurn,
    serviceRisk,
    riskLevel: highest,
    requiresExplicitConfirm: highest === "high",
    warnings,
    diffs,
  };
}

export function buildActionPreflight({
  actionType,
  targets,
  desiredReplicas,
  currentReplicas,
  note,
}: {
  actionType: Exclude<PreflightActionType, "apply">;
  targets: PreflightTarget[];
  desiredReplicas?: number | null;
  currentReplicas?: number | null;
  note?: string;
}): PreflightImpact {
  const warnings: PreflightWarning[] = [];
  const diffs: PreflightDiff[] = [];
  const affected = Math.max(targets.length, 1);
  const estimatedPods = estimateActionPods(actionType, targets, desiredReplicas);
  let serviceRisk: ServiceRisk = "none";
  let riskLevel: PreflightRiskLevel = "low";

  switch (actionType) {
    case "delete":
    case "helm-uninstall":
      riskLevel = "high";
      warnings.push({
        severity: "high",
        message: "Delete/uninstall removes live resources and may terminate pods immediately.",
      });
      break;
    case "restart":
      riskLevel = estimatedPods !== null && estimatedPods > 10 ? "high" : "medium";
      warnings.push({
        severity: riskLevel,
        message: "Rolling restart recreates pods according to each controller strategy.",
      });
      break;
    case "scale":
      riskLevel = desiredReplicas === 0 ? "high" : "medium";
      diffs.push({
        category: "replicas",
        severity: riskLevel,
        label: "replica count changed",
        before: formatMaybeNumber(currentReplicas ?? targets[0]?.currentReplicas ?? null),
        after: formatMaybeNumber(desiredReplicas ?? null),
      });
      warnings.push({
        severity: riskLevel,
        message:
          desiredReplicas === 0
            ? "Scaling to zero stops all pods behind this workload."
            : "Scaling changes pod count and may shift resource usage.",
      });
      break;
    case "set-image":
      riskLevel = "medium";
      warnings.push({
        severity: "medium",
        message: "Image change triggers a rollout and recreates pods for the workload.",
      });
      break;
    case "trigger":
      riskLevel = "medium";
      warnings.push({
        severity: "medium",
        message: "Manual trigger creates a Job from this CronJob spec.",
      });
      break;
    case "helm-install":
      riskLevel = "medium";
      warnings.push({
        severity: "medium",
        message: "Helm install can create multiple Kubernetes resources in the target namespace.",
      });
      serviceRisk = "possible-endpoint-change";
      break;
    case "helm-upgrade":
      riskLevel = "medium";
      warnings.push({
        severity: "medium",
        message: "Helm upgrade may update workloads, services, routes, RBAC, or CRDs rendered by the chart.",
      });
      serviceRisk = "possible-endpoint-change";
      break;
    case "helm-rollback":
      riskLevel = "medium";
      warnings.push({
        severity: "medium",
        message: "Helm rollback reapplies an older release manifest and can recreate pods.",
      });
      break;
    case "argocd-sync":
      riskLevel = "medium";
      warnings.push({
        severity: "medium",
        message: "ArgoCD sync reconciles desired state and may prune or recreate managed resources.",
      });
      serviceRisk = "possible-endpoint-change";
      break;
    case "argocd-refresh":
      riskLevel = "low";
      warnings.push({
        severity: "low",
        message: "Refresh asks ArgoCD to re-read state; it should not mutate Kubernetes workloads directly.",
      });
      break;
    case "argocd-rollback":
      riskLevel = "high";
      warnings.push({
        severity: "high",
        message: "ArgoCD rollback syncs an older revision with prune enabled; newer resources may be deleted.",
      });
      serviceRisk = "possible-endpoint-change";
      break;
    case "argocd-terminate":
      riskLevel = "medium";
      warnings.push({
        severity: "medium",
        message: "Terminate stops the running ArgoCD operation but does not roll back resources already reconciled.",
      });
      break;
  }

  if (note) {
    warnings.push({ severity: "low", message: note });
  }

  return {
    actionType,
    targetLabel: formatTargets(targets),
    namespace: sharedNamespace(targets),
    affectedResourceCount: affected,
    podChurn: podChurnFor(estimatedPods, diffs, actionType),
    serviceRisk,
    riskLevel,
    requiresExplicitConfirm: riskLevel === "high",
    warnings,
    diffs,
  };
}

export function parseReadyReplicas(ready: string | undefined): number | null {
  if (!ready) return null;
  const match = ready.match(/^\d+\/(\d+)$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseKubeYamlDocs(yaml: string): KubeYamlDoc[] {
  return yaml
    .split(/^---\s*$/m)
    .map((doc) => doc.trim())
    .filter(Boolean)
    .map(parseKubeYamlDoc);
}

function parseKubeYamlDoc(raw: string): KubeYamlDoc {
  const kind = matchScalar(raw, "kind") ?? "Unknown";
  const podProducing = isPodProducingKind(kind);
  return {
    kind,
    namespace: matchMetadataScalar(raw, "namespace"),
    name: matchMetadataScalar(raw, "name") ?? matchScalar(raw, "name") ?? "unknown",
    replicas: matchNumber(raw, "replicas"),
    images: sortedUnique(matchAllScalars(raw, "image")),
    selectorBlock: normalizeBlock(extractFirstBlock(raw, "selector")),
    serviceSelectorBlock: normalizeBlock(extractFirstBlock(raw, "selector")),
    servicePortsBlock: normalizeBlock(extractFirstBlock(raw, "ports")),
    ingressRoutes: sortedUnique([
      ...matchAllScalars(raw, "host"),
      ...matchAllScalars(raw, "path"),
    ]),
    probeNames: ["readinessProbe", "livenessProbe", "startupProbe"].filter((key) =>
      new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`, "m").test(raw),
    ),
    resourcesBlocks: podProducing
      ? extractBlocks(raw, "resources").map(normalizeBlock).filter(Boolean)
      : [],
    networkPolicyBroad: detectBroadNetworkPolicy(raw),
    rbacBroad: detectBroadRbac(raw),
    raw,
  };
}

function matchScalar(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*:\\s*(.+?)\\s*$`, "m"));
  return match ? stripYamlValue(match[1]) : null;
}

function matchMetadataScalar(raw: string, key: string): string | null {
  const metadata = extractFirstBlock(raw, "metadata");
  return metadata ? matchScalar(metadata, key) : null;
}

function matchNumber(raw: string, key: string): number | null {
  const value = matchScalar(raw, key);
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchAllScalars(raw: string, key: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`^\\s*(?:-\\s*)?${escapeRegExp(key)}\\s*:\\s*(.+?)\\s*$`, "gm");
  for (const match of raw.matchAll(re)) out.push(stripYamlValue(match[1]));
  return out.filter(Boolean);
}

function extractFirstBlock(raw: string, key: string): string {
  return extractBlocks(raw, key)[0] ?? "";
}

function extractBlocks(raw: string, key: string): string[] {
  const lines = raw.split(/\r?\n/);
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*:\\s*(.*)$`));
    if (!match) continue;
    const indent = match[1].length;
    const block = [line.trimEnd()];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (!next.trim()) {
        block.push(next);
        continue;
      }
      const nextIndent = next.match(/^(\s*)/)?.[1].length ?? 0;
      if (nextIndent <= indent) break;
      block.push(next.trimEnd());
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

function normalizeBlock(block: string): string {
  if (!block) return "";
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, "").trimEnd())
    .filter((line) => line.trim().length > 0);
  const minIndent = Math.min(
    ...lines
      .filter((line) => line.trim())
      .map((line) => line.match(/^(\s*)/)?.[1].length ?? 0),
  );
  return lines.map((line) => line.slice(minIndent)).join("\n").trim();
}

function stripYamlValue(value: string): string {
  return value
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^\[(.*)\]$/, "$1")
    .trim();
}

function detectBroadNetworkPolicy(raw: string): boolean {
  return /podSelector\s*:\s*\{\s*\}/.test(raw) || /-\s*\{\s*\}/.test(raw);
}

function detectBroadRbac(raw: string): boolean {
  if (/\[\s*["']?\*["']?\s*\]/.test(raw) || /^-\s*["']?\*["']?\s*$/m.test(raw)) {
    return true;
  }
  const riskyVerbs = new Set([
    "create",
    "update",
    "patch",
    "delete",
    "deletecollection",
    "bind",
    "escalate",
    "impersonate",
  ]);
  const verbs = extractFirstBlock(raw, "verbs").toLowerCase();
  return [...riskyVerbs].some((verb) => new RegExp(`\\b${verb}\\b`).test(verbs));
}

function isRbacKind(kind: string): boolean {
  return ["role", "clusterrole", "rolebinding", "clusterrolebinding"].includes(
    kind.toLowerCase(),
  );
}

function sameArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function highestRisk(
  severities: PreflightRiskLevel[],
  warnings: PreflightWarning[],
): PreflightRiskLevel {
  if (severities.includes("high") || warnings.some((warning) => warning.severity === "high")) {
    return "high";
  }
  if (
    severities.includes("medium") ||
    warnings.some((warning) => warning.severity === "medium")
  ) {
    return "medium";
  }
  return "low";
}

function estimateYamlPods(
  afterDocs: KubeYamlDoc[],
  beforeDocs: KubeYamlDoc[],
  target: PreflightTarget,
): number | null {
  const workload = afterDocs.find((doc) => isPodProducingKind(doc.kind)) ??
    beforeDocs.find((doc) => isPodProducingKind(doc.kind));
  if (!workload && !isPodProducingKind(target.kind)) return null;
  return workload?.replicas ?? target.replicas ?? target.currentReplicas ?? 1;
}

function estimateActionPods(
  actionType: PreflightActionType,
  targets: PreflightTarget[],
  desiredReplicas?: number | null,
): number | null {
  if (actionType === "scale") return desiredReplicas ?? targets[0]?.replicas ?? null;
  if (
    ![
      "delete",
      "restart",
      "set-image",
      "helm-upgrade",
      "helm-rollback",
      "helm-uninstall",
    ].includes(actionType)
  ) {
    return null;
  }
  const podTargets = targets.filter((target) => isPodProducingKind(target.kind));
  if (podTargets.length === 0) return null;
  return podTargets.reduce(
    (sum, target) => sum + (target.replicas ?? target.currentReplicas ?? 1),
    0,
  );
}

function podChurnFor(
  estimatedPods: number | null,
  diffs: PreflightDiff[],
  actionType: PreflightActionType,
): PreflightImpact["podChurn"] {
  const changesPods =
    ["delete", "restart", "scale", "set-image", "helm-upgrade", "helm-rollback", "helm-uninstall"].includes(
      actionType,
    ) ||
    diffs.some((diff) =>
      ["image", "replicas", "selector", "probe", "resources"].includes(diff.category),
    );
  if (!changesPods) {
    return { level: "none", estimatedPods: null, summary: "No pod recreation detected locally." };
  }
  const count = estimatedPods ?? null;
  const hasHighRiskPodDiff = diffs.some(
    (diff) =>
      diff.severity === "high" &&
      ["selector", "probe", "replicas"].includes(diff.category),
  );
  const level: PodChurnLevel =
    hasHighRiskPodDiff || count === 0
      ? "high"
      : count === null
        ? "low"
        : count > 10
          ? "medium"
          : "low";
  const summary =
    count === null
      ? "Pod churn possible; exact count is not available locally."
      : count === 0
        ? "Scale target is zero pods."
        : `Up to ${count} pod${count === 1 ? "" : "s"} may be recreated or rescheduled.`;
  return { level, estimatedPods: count, summary };
}

function isPodProducingKind(kind: string): boolean {
  const normalized = kind.toLowerCase() as WorkloadKind;
  return [
    "deployment",
    "statefulset",
    "daemonset",
    "replicaset",
    "replicationcontroller",
    "job",
    "cronjob",
    "pod",
  ].includes(normalized);
}

function formatTargets(targets: PreflightTarget[]): string {
  if (targets.length === 0) return "unknown target";
  if (targets.length === 1) {
    const target = targets[0];
    return `${target.kind}/${target.name}`;
  }
  return `${targets.length} selected resources`;
}

function sharedNamespace(targets: PreflightTarget[]): string | null {
  const namespaces = new Set(targets.map((target) => target.namespace ?? null));
  return namespaces.size === 1 ? [...namespaces][0] : null;
}

function formatMaybeNumber(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
