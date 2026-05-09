import { describe, expect, it } from "vitest";
import {
  compareClusterResources,
  resourceFromWorkloadSummary,
  type ClusterCompareResource,
} from "./clusterCompare";
import type { WorkloadSummary } from "./k8s";

const baseResource = (
  overrides: Partial<ClusterCompareResource> = {},
): ClusterCompareResource => ({
  kind: "deployment",
  namespace: "payments",
  name: "api",
  status: "healthy",
  ready: "3/3",
  replicas: { ready: 3, desired: 3 },
  restartCount: 0,
  ...overrides,
});

describe("compareClusterResources", () => {
  it("reports missing and extra resources by kind/name across selected namespaces", () => {
    const result = compareClusterResources({
      source: [
        baseResource({ name: "api" }),
        baseResource({ name: "worker" }),
      ],
      target: [
        baseResource({ name: "api" }),
        baseResource({ name: "scheduler" }),
      ],
      sourceLabel: "dev",
      targetLabel: "prod",
    });

    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "missing",
          severity: "high",
          key: "deployment/payments/worker",
          evidence: "present in dev, missing in prod",
        }),
        expect.objectContaining({
          category: "extra",
          severity: "medium",
          key: "deployment/payments/scheduler",
          evidence: "missing in dev, present in prod",
        }),
      ]),
    );
    expect(result.counts).toMatchObject({ missing: 1, extra: 1 });
  });

  it("reports image drift with container-level evidence", () => {
    const result = compareClusterResources({
      source: [
        baseResource({
          images: [{ container: "api", image: "ghcr.io/acme/api:1.2.0" }],
        }),
      ],
      target: [
        baseResource({
          images: [{ container: "api", image: "ghcr.io/acme/api:1.3.1" }],
        }),
      ],
    });

    expect(result.rows).toContainEqual(
      expect.objectContaining({
        category: "image",
        severity: "high",
        evidence: "api image ghcr.io/acme/api:1.2.0 -> ghcr.io/acme/api:1.3.1",
      }),
    );
  });

  it("reports replica, readiness, and restart drift from summary facts", () => {
    const result = compareClusterResources({
      source: [
        baseResource({
          ready: "2/2",
          replicas: { ready: 2, desired: 2 },
          restartCount: 0,
        }),
      ],
      target: [
        baseResource({
          ready: "3/4",
          replicas: { ready: 3, desired: 4 },
          restartCount: 6,
        }),
      ],
    });

    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "replicas",
          severity: "medium",
          evidence: "desired replicas 2 -> 4; ready replicas 2 -> 3",
        }),
        expect.objectContaining({
          category: "restarts",
          severity: "medium",
          evidence: "restart count 0 -> 6",
        }),
      ]),
    );
  });

  it("reports environment and config reference drift", () => {
    const result = compareClusterResources({
      source: [
        baseResource({
          env: { FEATURE_FLAG: "off", LOG_LEVEL: "info" },
          configRefs: ["configmap/app-v1", "secret/payments"],
        }),
      ],
      target: [
        baseResource({
          env: { FEATURE_FLAG: "on", LOG_LEVEL: "info" },
          configRefs: ["configmap/app-v2", "secret/payments"],
        }),
      ],
    });

    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "config",
          severity: "high",
          evidence: "env FEATURE_FLAG off -> on",
        }),
        expect.objectContaining({
          category: "config",
          severity: "high",
          evidence: "config refs configmap/app-v1, secret/payments -> configmap/app-v2, secret/payments",
        }),
      ]),
    );
  });

  it("reports Helm and ArgoCD status drift when integration facts are present", () => {
    const result = compareClusterResources({
      source: [
        baseResource({
          helm: { release: "api", revision: 7, chart: "api-1.2.0", status: "deployed" },
          argo: { syncStatus: "Synced", healthStatus: "Healthy", targetRevision: "main" },
        }),
      ],
      target: [
        baseResource({
          helm: { release: "api", revision: 8, chart: "api-1.3.0", status: "failed" },
          argo: { syncStatus: "OutOfSync", healthStatus: "Degraded", targetRevision: "release" },
        }),
      ],
    });

    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "helm",
          severity: "high",
          evidence: "Helm status deployed -> failed; chart api-1.2.0 -> api-1.3.0; revision 7 -> 8",
        }),
        expect.objectContaining({
          category: "argocd",
          severity: "high",
          evidence: "ArgoCD sync Synced -> OutOfSync; health Healthy -> Degraded; revision main -> release",
        }),
      ]),
    );
  });

  it("filters by kind and search while preserving deterministic severity order", () => {
    const result = compareClusterResources({
      source: [
        baseResource({ kind: "deployment", name: "api" }),
        baseResource({ kind: "statefulset", name: "postgres", status: "healthy" }),
      ],
      target: [
        baseResource({ kind: "deployment", name: "api", status: "failed" }),
        baseResource({ kind: "statefulset", name: "postgres", status: "failed" }),
      ],
      filters: { kinds: ["statefulset"], search: "post" },
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual(
      expect.objectContaining({
        kind: "statefulset",
        name: "postgres",
        category: "status",
        evidence: "status healthy -> failed",
      }),
    );
  });
});

describe("resourceFromWorkloadSummary", () => {
  it("normalizes workload summaries into compare resources", () => {
    const summary: WorkloadSummary = {
      kind: "pod",
      namespace: "default",
      name: "api-123",
      ready: "1/2",
      health: "degraded",
      labels: {},
      age_seconds: 100,
      restart_count: 4,
      pod_phase: "Pending",
    };

    expect(resourceFromWorkloadSummary(summary)).toMatchObject({
      kind: "pod",
      namespace: "default",
      name: "api-123",
      status: "Pending",
      ready: "1/2",
      replicas: { ready: 1, desired: 2 },
      restartCount: 4,
    });
  });
});
