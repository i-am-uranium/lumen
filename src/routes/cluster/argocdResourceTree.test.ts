import { describe, expect, it } from "vitest";
import type { ArgoApplicationResource } from "@/lib/k8s";
import { groupResourcesByKind } from "./argocdResourceTree";

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

describe("groupResourcesByKind", () => {
  it("returns an empty list for no resources", () => {
    expect(groupResourcesByKind([])).toEqual([]);
  });

  it("buckets resources by Kind, sorted by namespace then name within each bucket", () => {
    const groups = groupResourcesByKind([
      res("Deployment", "frontend", "team-a"),
      res("Deployment", "api", "team-b"),
      res("Deployment", "api", "team-a"),
      res("Service", "frontend", "team-a"),
    ]);
    const deploys = groups.find((g) => g.kind === "Deployment");
    const services = groups.find((g) => g.kind === "Service");
    expect(deploys?.resources.map((r) => `${r.namespace}/${r.name}`)).toEqual([
      "team-a/api",
      "team-a/frontend",
      "team-b/api",
    ]);
    expect(services?.resources.map((r) => r.name)).toEqual(["frontend"]);
  });

  it("orders well-known Kinds in workloads-first priority", () => {
    const groups = groupResourcesByKind([
      res("ConfigMap", "shared"),
      res("Service", "api"),
      res("Pod", "api-xyz"),
      res("Deployment", "api"),
      res("Namespace", "team-a", null),
      res("ServiceAccount", "default"),
    ]);
    expect(groups.map((g) => g.kind)).toEqual([
      "Namespace",
      "Deployment",
      "Pod",
      "Service",
      "ConfigMap",
      "ServiceAccount",
    ]);
  });

  it("places unknown Kinds after well-known ones, alphabetically", () => {
    const groups = groupResourcesByKind([
      res("MyCustomCRD", "thing"),
      res("AnotherCRD", "other"),
      res("Deployment", "api"),
    ]);
    expect(groups.map((g) => g.kind)).toEqual([
      "Deployment",
      "AnotherCRD",
      "MyCustomCRD",
    ]);
  });

  it("treats missing kind as 'Unknown' rather than crashing", () => {
    const groups = groupResourcesByKind([
      { ...res("", "weird"), kind: "" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("Unknown");
  });

  it("handles cluster-scoped resources (null namespace) without errors", () => {
    const groups = groupResourcesByKind([
      res("ClusterRole", "viewer", null),
      res("ClusterRole", "editor", null),
    ]);
    expect(groups[0].resources.map((r) => r.name)).toEqual(["editor", "viewer"]);
  });
});
