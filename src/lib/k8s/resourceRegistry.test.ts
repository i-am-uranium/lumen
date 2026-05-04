import { describe, expect, it } from "vitest";
import {
  ALL_RESOURCE_DEFINITIONS,
  getResourceDefinition,
  listResourceDefinitions,
  resourceKindToSlug,
} from "./resourceRegistry";

describe("resourceRegistry", () => {
  it("contains the v1 desktop parity resource kinds without duplicate slugs", () => {
    const kinds = ALL_RESOURCE_DEFINITIONS.map((definition) => definition.kind);
    expect(kinds).toEqual([
      "pod",
      "deployment",
      "statefulset",
      "daemonset",
      "replicaset",
      "replicationcontroller",
      "job",
      "cronjob",
      "service",
      "ingress",
      "ingressclass",
      "endpoint",
      "endpointslice",
      "configmap",
      "secret",
      "serviceaccount",
      "role",
      "rolebinding",
      "clusterrole",
      "clusterrolebinding",
      "networkpolicy",
      "persistentvolumeclaim",
      "persistentvolume",
      "storageclass",
      "volumeattributesclass",
      "resourcequota",
      "horizontalpodautoscaler",
      "verticalpodautoscaler",
      "limitrange",
      "poddisruptionbudget",
      "priorityclass",
      "runtimeclass",
      "lease",
      "controllerrevision",
      "mutatingwebhookconfiguration",
      "validatingwebhookconfiguration",
      "gatewayclass",
      "gateway",
      "httproute",
      "grpcroute",
      "jobset",
      "customresourcedefinition",
    ]);

    const slugs = ALL_RESOURCE_DEFINITIONS.map((definition) => definition.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("describes API scope and mutability for representative resources", () => {
    expect(getResourceDefinition("pod")).toMatchObject({
      apiGroup: "",
      version: "v1",
      plural: "pods",
      namespaced: true,
      category: "workloads",
      supportsLogs: true,
      supportsShell: true,
    });
    expect(getResourceDefinition("clusterrole")).toMatchObject({
      apiGroup: "rbac.authorization.k8s.io",
      version: "v1",
      plural: "clusterroles",
      namespaced: false,
      category: "rbac",
    });
    expect(getResourceDefinition("gateway")).toMatchObject({
      apiGroup: "gateway.networking.k8s.io",
      version: "v1",
      plural: "gateways",
      namespaced: true,
      category: "network",
      optional: true,
    });
  });

  it("returns ordered definitions by category without exposing internal arrays", () => {
    const workloads = listResourceDefinitions({ category: "workloads" });
    expect(workloads.map((definition) => definition.kind)).toEqual([
      "pod",
      "deployment",
      "statefulset",
      "daemonset",
      "replicaset",
      "replicationcontroller",
      "job",
      "cronjob",
      "jobset",
    ]);

    workloads.pop();
    expect(listResourceDefinitions({ category: "workloads" })).toHaveLength(9);
  });

  it("maps resource kinds to stable URL slugs", () => {
    expect(resourceKindToSlug("horizontalpodautoscaler")).toBe("hpas");
    expect(resourceKindToSlug("clusterrolebinding")).toBe("clusterrolebindings");
    expect(resourceKindToSlug("customresourcedefinition")).toBe("crds");
  });
});
