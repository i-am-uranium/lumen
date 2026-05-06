import { describe, expect, it } from "vitest";
import type { ArgoApplicationResource } from "@/lib/k8s";
import {
  buildOwnerTree,
  flattenTree,
  ownerTreeNodeKey,
  type ResourceWithOwner,
} from "./argocdOwnerTree";

function res(
  kind: string,
  name: string,
  namespace: string | null = "default",
): ArgoApplicationResource {
  return {
    group: "",
    kind,
    name,
    namespace,
    sync_status: "Synced",
    health_status: "Healthy",
    health_message: null,
  };
}

describe("buildOwnerTree", () => {
  it("returns an empty list for no input", () => {
    expect(buildOwnerTree([])).toEqual([]);
  });

  it("treats resources with no owner data as roots", () => {
    const input: ResourceWithOwner[] = [
      { resource: res("Deployment", "api"), owner: undefined },
      { resource: res("Service", "api"), owner: null },
    ];
    const tree = buildOwnerTree(input);
    expect(tree.map((n) => n.resource.kind).sort()).toEqual([
      "Deployment",
      "Service",
    ]);
    for (const node of tree) expect(node.children).toEqual([]);
  });

  it("nests a child under its owner when both are managed", () => {
    const input: ResourceWithOwner[] = [
      { resource: res("Deployment", "api"), owner: null },
      {
        resource: res("ReplicaSet", "api-abc"),
        owner: { kind: "Deployment", name: "api" },
      },
    ];
    const tree = buildOwnerTree(input);
    expect(tree).toHaveLength(1);
    expect(tree[0].resource.kind).toBe("Deployment");
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].resource.kind).toBe("ReplicaSet");
  });

  it("builds Deployment → ReplicaSet → Pod chains", () => {
    const input: ResourceWithOwner[] = [
      { resource: res("Deployment", "api"), owner: null },
      {
        resource: res("ReplicaSet", "api-abc"),
        owner: { kind: "Deployment", name: "api" },
      },
      {
        resource: res("Pod", "api-abc-xyz"),
        owner: { kind: "ReplicaSet", name: "api-abc" },
      },
    ];
    const tree = buildOwnerTree(input);
    expect(tree).toHaveLength(1);
    expect(tree[0].resource.kind).toBe("Deployment");
    expect(tree[0].children[0].resource.kind).toBe("ReplicaSet");
    expect(tree[0].children[0].children[0].resource.kind).toBe("Pod");
  });

  it("falls back to root when the owner isn't in the managed set", () => {
    const input: ResourceWithOwner[] = [
      // ReplicaSet says it's owned by a Deployment ArgoCD doesn't manage.
      {
        resource: res("ReplicaSet", "orphan-rs"),
        owner: { kind: "Deployment", name: "ghost"},
      },
    ];
    const tree = buildOwnerTree(input);
    expect(tree).toHaveLength(1);
    expect(tree[0].resource.name).toBe("orphan-rs");
  });

  it("handles a self-referencing owner without infinite recursion", () => {
    const input: ResourceWithOwner[] = [
      {
        resource: res("Deployment", "loopy"),
        owner: { kind: "Deployment", name: "loopy" },
      },
    ];
    const tree = buildOwnerTree(input);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toEqual([]);
  });

  it("sorts siblings by namespace then name", () => {
    const input: ResourceWithOwner[] = [
      { resource: res("Deployment", "z", "team-b"), owner: null },
      { resource: res("Deployment", "a", "team-a"), owner: null },
      { resource: res("Deployment", "b", "team-a"), owner: null },
    ];
    const tree = buildOwnerTree(input);
    expect(tree.map((n) => `${n.resource.namespace}/${n.resource.name}`)).toEqual(
      ["team-a/a", "team-a/b", "team-b/z"],
    );
  });

  it("uses namespace + kind + name to disambiguate same-named resources", () => {
    // Two ReplicaSets with the same name in different namespaces — only the
    // matching one (by namespace) should attach to its Deployment.
    const input: ResourceWithOwner[] = [
      { resource: res("Deployment", "api", "team-a"), owner: null },
      { resource: res("Deployment", "api", "team-b"), owner: null },
      {
        resource: res("ReplicaSet", "api-1", "team-a"),
        owner: { kind: "Deployment", name: "api" },
      },
      {
        resource: res("ReplicaSet", "api-1", "team-b"),
        owner: { kind: "Deployment", name: "api" },
      },
    ];
    const tree = buildOwnerTree(input);
    expect(tree).toHaveLength(2);
    for (const dep of tree) {
      expect(dep.children).toHaveLength(1);
      expect(dep.children[0].resource.namespace).toBe(dep.resource.namespace);
    }
  });
});

describe("flattenTree", () => {
  function chain(): ResourceWithOwner[] {
    return [
      { resource: res("Deployment", "api"), owner: null },
      {
        resource: res("ReplicaSet", "api-abc"),
        owner: { kind: "Deployment", name: "api" },
      },
      {
        resource: res("Pod", "api-abc-xyz"),
        owner: { kind: "ReplicaSet", name: "api-abc" },
      },
    ];
  }

  it("yields depth-annotated rows in DFS order", () => {
    const tree = buildOwnerTree(chain());
    const rows = flattenTree(tree, new Set());
    expect(rows.map((r) => `${r.depth}:${r.resource.kind}`)).toEqual([
      "0:Deployment",
      "1:ReplicaSet",
      "2:Pod",
    ]);
  });

  it("skips subtrees whose root is in the collapsed set", () => {
    const tree = buildOwnerTree(chain());
    const collapsed = new Set([ownerTreeNodeKey(res("Deployment", "api"))]);
    const rows = flattenTree(tree, collapsed);
    expect(rows.map((r) => r.resource.kind)).toEqual(["Deployment"]);
  });

  it("marks rows with hasChildren correctly", () => {
    const tree = buildOwnerTree(chain());
    const rows = flattenTree(tree, new Set());
    expect(rows.find((r) => r.resource.kind === "Deployment")?.hasChildren).toBe(
      true,
    );
    expect(rows.find((r) => r.resource.kind === "Pod")?.hasChildren).toBe(false);
  });
});
