/**
 * Pure helper: groups ArgoCD-managed resources by Kind for the
 * tree-style detail view.
 *
 * We intentionally don't pull in `parentRefs` / owner-reference
 * topology yet. ArgoCD's REST API exposes a richer per-Application
 * resource tree (Deployment → ReplicaSet → Pod) but it requires
 * either a separate endpoint or a per-resource K8s round-trip; the
 * Application CRD's `.status.resources[]` only lists the directly
 * managed roots. Kind-grouping is the meaningful upgrade we can
 * ship from data we already have.
 *
 * Owner-ref nesting is a planned follow-up.
 */
import type { ArgoApplicationResource } from "@/lib/k8s";

/**
 * One grouped section in the tree view: the Kind label plus all
 * resources of that Kind, alphabetically sorted by namespace +
 * name. Stable sort means consecutive renders don't reshuffle
 * rows — important for the hover affordances.
 */
export type ResourceGroup = {
  kind: string;
  resources: ArgoApplicationResource[];
};

/**
 * Order Kinds appear in the tree. Roughly mirrors ArgoCD's own
 * web UI: workloads first, then services / config, then RBAC and
 * everything else alphabetical. Anything not in this table sorts
 * after listed Kinds, alphabetically.
 *
 * Using a Map<Kind, weight> lets us score by `priority.get(kind) ??
 * Number.MAX_SAFE_INTEGER` — clearer than string-comparing against a
 * positional index.
 */
const KIND_PRIORITY: ReadonlyMap<string, number> = new Map([
  ["Namespace", 0],
  ["Deployment", 10],
  ["StatefulSet", 11],
  ["DaemonSet", 12],
  ["Rollout", 13],
  ["CronJob", 14],
  ["Job", 15],
  ["ReplicaSet", 16],
  ["Pod", 17],
  ["Service", 30],
  ["Ingress", 31],
  ["HTTPRoute", 32],
  ["Gateway", 33],
  ["NetworkPolicy", 34],
  ["ConfigMap", 50],
  ["Secret", 51],
  ["PersistentVolumeClaim", 52],
  ["PersistentVolume", 53],
  ["ServiceAccount", 70],
  ["Role", 71],
  ["RoleBinding", 72],
  ["ClusterRole", 73],
  ["ClusterRoleBinding", 74],
]);

function kindWeight(kind: string): number {
  return KIND_PRIORITY.get(kind) ?? Number.MAX_SAFE_INTEGER;
}

function compareResources(
  a: ArgoApplicationResource,
  b: ArgoApplicationResource,
): number {
  const nsA = a.namespace ?? "";
  const nsB = b.namespace ?? "";
  if (nsA !== nsB) return nsA.localeCompare(nsB);
  return a.name.localeCompare(b.name);
}

/**
 * Group a flat list of managed resources into kind-based sections,
 * each sorted by namespace then name. Empty input → empty output.
 *
 * Pure (no React, no dates) so it's trivially unit-testable.
 */
export function groupResourcesByKind(
  resources: ArgoApplicationResource[],
): ResourceGroup[] {
  const buckets = new Map<string, ArgoApplicationResource[]>();
  for (const r of resources) {
    const key = r.kind || "Unknown";
    const list = buckets.get(key);
    if (list) list.push(r);
    else buckets.set(key, [r]);
  }
  const groups: ResourceGroup[] = [];
  for (const [kind, list] of buckets) {
    list.sort(compareResources);
    groups.push({ kind, resources: list });
  }
  groups.sort((a, b) => {
    const wa = kindWeight(a.kind);
    const wb = kindWeight(b.kind);
    if (wa !== wb) return wa - wb;
    return a.kind.localeCompare(b.kind);
  });
  return groups;
}
