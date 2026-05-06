/**
 * Pure helper: builds an owner-reference tree out of ArgoCD-managed
 * resources plus the owner refs we've fetched from K8s for each one.
 *
 * Why this exists
 * ───────────────
 * ArgoCD's Application status only lists directly-managed roots
 * (Deployment, Service, …) — the controller does not record
 * Deployment → ReplicaSet → Pod descent. To get a real topology
 * we have to either talk to argocd-server's HTTP API (requires
 * service discovery + auth, out of scope) or pull `metadata.ownerReferences`
 * from each managed K8s object directly. We do the latter via Lumen's
 * existing `k8s.getResource` API, parallelized with React Query's
 * `useQueries`.
 *
 * What this file does NOT do
 * ──────────────────────────
 * • Issue any network calls — purely a tree-builder.
 * • Recurse into descendants the Application doesn't already manage.
 *   In ArgoCD's model the "managed resources" set is the universe
 *   we're allowed to render; if a Deployment owns a ReplicaSet that
 *   ArgoCD doesn't track, that ReplicaSet won't show up here.
 *
 * Algorithm
 * ─────────
 * For each managed resource we have an optional `owner` (kind + name,
 * namespace inferred from the child since owner refs are always
 * same-namespace for namespaced resources). We index every resource
 * by `${kind}/${namespace}/${name}` and link each child to its owner
 * if and only if that owner is also in the managed set. Otherwise the
 * child is a root.
 *
 * Cycles are theoretically impossible in K8s (owner refs are a DAG),
 * but we still defend against them by tracking seen nodes during
 * the build to keep the function total even with malformed input.
 */
import type { ArgoApplicationResource } from "@/lib/k8s";

/**
 * Per-resource owner-reference fact, as returned by Lumen's
 * `k8s.getResource` API. We only need the controller (or first) owner —
 * K8s guarantees at most one `controller: true` ownerRef per object,
 * and that's the parent we want to nest under. The kind/name pair is
 * sufficient because owner refs always live in the same namespace.
 */
export type OwnerFact = {
  kind: string;
  name: string;
};

/**
 * Input shape: one managed resource plus what we know about its owner
 * (if anything). `owner === undefined` means we couldn't fetch the
 * K8s object (cluster-scoped CRD Lumen doesn't know about, RBAC,
 * not-found, etc.) — those resources fall back to being roots.
 * `owner === null` means we fetched it and it's a top-level object
 * with no controller — also a root.
 */
export type ResourceWithOwner = {
  resource: ArgoApplicationResource;
  owner: OwnerFact | null | undefined;
};

/**
 * One node in the owner tree. Children are recursive nodes, sorted
 * the same way as the kind-grouped helper sorts within a kind:
 * by namespace, then by name.
 */
export type OwnerTreeNode = {
  resource: ArgoApplicationResource;
  children: OwnerTreeNode[];
};

function resourceKey(r: ArgoApplicationResource): string {
  return `${r.kind}/${r.namespace ?? ""}/${r.name}`;
}

function ownerKeyForChild(
  child: ArgoApplicationResource,
  owner: OwnerFact,
): string {
  // Owner refs are always same-namespace for namespaced resources;
  // for cluster-scoped children we still index with empty namespace.
  return `${owner.kind}/${child.namespace ?? ""}/${owner.name}`;
}

function compareNodes(a: OwnerTreeNode, b: OwnerTreeNode): number {
  const nsA = a.resource.namespace ?? "";
  const nsB = b.resource.namespace ?? "";
  if (nsA !== nsB) return nsA.localeCompare(nsB);
  return a.resource.name.localeCompare(b.resource.name);
}

/**
 * Build the owner-ref tree. Always returns the full set of resources
 * exactly once across the tree — children that can't be linked to a
 * managed parent are surfaced as roots so nothing gets dropped.
 */
export function buildOwnerTree(input: ResourceWithOwner[]): OwnerTreeNode[] {
  const nodes = new Map<string, OwnerTreeNode>();
  for (const { resource } of input) {
    nodes.set(resourceKey(resource), { resource, children: [] });
  }

  const roots: OwnerTreeNode[] = [];
  // Track nodes we've already attached as a child so a malformed
  // `owner === itself` self-reference can't loop forever.
  const attached = new Set<string>();
  for (const { resource, owner } of input) {
    const childKey = resourceKey(resource);
    const childNode = nodes.get(childKey);
    if (!childNode) continue;
    if (!owner) {
      roots.push(childNode);
      continue;
    }
    const parentKey = ownerKeyForChild(resource, owner);
    if (parentKey === childKey) {
      // Pathological self-reference — render as a root.
      roots.push(childNode);
      continue;
    }
    const parentNode = nodes.get(parentKey);
    if (!parentNode) {
      roots.push(childNode);
      continue;
    }
    parentNode.children.push(childNode);
    attached.add(childKey);
  }

  // Sort every children-list deterministically.
  for (const node of nodes.values()) {
    node.children.sort(compareNodes);
  }
  roots.sort(compareNodes);
  return roots;
}

/**
 * Flatten a built tree into depth-annotated rows for renderers that
 * prefer to draw a flat list with indent + chevron markers (much
 * easier than recursive components when each row has hover affordances).
 *
 * `collapsed` is a set of resource keys whose subtrees should be
 * skipped. The caller supplies whatever set-of-keys it wants — the
 * helper doesn't care whether collapse state is per-render or
 * persisted.
 */
export type FlatRow = {
  resource: ArgoApplicationResource;
  depth: number;
  hasChildren: boolean;
  /** Stable key for collapse-set lookup and React keys. */
  key: string;
};

export function flattenTree(
  roots: OwnerTreeNode[],
  collapsed: ReadonlySet<string>,
): FlatRow[] {
  const out: FlatRow[] = [];
  function walk(node: OwnerTreeNode, depth: number): void {
    const key = resourceKey(node.resource);
    out.push({
      resource: node.resource,
      depth,
      hasChildren: node.children.length > 0,
      key,
    });
    if (collapsed.has(key)) return;
    for (const child of node.children) walk(child, depth + 1);
  }
  for (const root of roots) walk(root, 0);
  return out;
}

/** Stable resource-key helper exposed for collapse-set lookup at the call site. */
export function ownerTreeNodeKey(r: ArgoApplicationResource): string {
  return resourceKey(r);
}
