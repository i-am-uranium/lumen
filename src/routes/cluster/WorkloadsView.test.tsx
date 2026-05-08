import { describe, expect, it } from "vitest";
import {
  buildSelectedWorkloadsAiContext,
  matchQuickFilters,
  restartEligibleWorkloads,
  selectVisibleWorkloadKeys,
  sortWorkloads,
  workloadSelectionKey,
  workloadRiskScore,
  type QuickFilter,
} from "./WorkloadsView";
import type { WorkloadSummary } from "@/lib/k8s";

function workload(overrides: Partial<WorkloadSummary>): WorkloadSummary {
  return {
    kind: "deployment",
    name: "api",
    namespace: "default",
    ready: "1/1",
    age_seconds: 3600,
    health: "healthy",
    labels: {},
    ...overrides,
  };
}

describe("workload triage helpers", () => {
  it("scores failed and degraded workloads ahead of healthy resources", () => {
    expect(workloadRiskScore(workload({ health: "failed" }))).toBeLessThan(
      workloadRiskScore(workload({ health: "degraded" })),
    );
    expect(workloadRiskScore(workload({ health: "degraded" }))).toBeLessThan(
      workloadRiskScore(workload({ health: "healthy" })),
    );
  });

  it("scores restarted and non-running pods as triage risks", () => {
    const healthyPod = workload({ kind: "pod", pod_phase: "Running" });
    const restartedPod = workload({
      kind: "pod",
      pod_phase: "Running",
      restart_count: 1,
    });
    const pendingPod = workload({ kind: "pod", pod_phase: "Pending" });

    expect(workloadRiskScore(restartedPod)).toBeLessThan(
      workloadRiskScore(healthyPod),
    );
    expect(workloadRiskScore(pendingPod)).toBeLessThan(
      workloadRiskScore(healthyPod),
    );
  });

  it("matches quick filters against health, restarts, and pod phase", () => {
    const filters = new Set<QuickFilter>(["unhealthy", "restarts"]);

    expect(
      matchQuickFilters(
        workload({ health: "degraded", restart_count: 2 }),
        filters,
      ),
    ).toBe(true);
    expect(
      matchQuickFilters(
        workload({ health: "degraded", restart_count: 0 }),
        filters,
      ),
    ).toBe(false);
    expect(
      matchQuickFilters(
        workload({ health: "healthy", restart_count: 2 }),
        filters,
      ),
    ).toBe(false);
  });
});

describe("workload sorting helpers", () => {
  it("sorts by namespace, name, and kind", () => {
    const rows = [
      workload({ kind: "statefulset", namespace: "beta", name: "db" }),
      workload({ kind: "deployment", namespace: "alpha", name: "web" }),
      workload({ kind: "daemonset", namespace: "alpha", name: "agent" }),
    ];

    expect(
      sortWorkloads(rows, { key: "namespace", direction: "asc" }).map((w) =>
        `${w.namespace}/${w.name}`,
      ),
    ).toEqual(["alpha/agent", "alpha/web", "beta/db"]);
    expect(
      sortWorkloads(rows, { key: "name", direction: "desc" }).map((w) => w.name),
    ).toEqual(["web", "db", "agent"]);
    expect(
      sortWorkloads(rows, { key: "kind", direction: "asc" }).map((w) => w.kind),
    ).toEqual(["daemonset", "deployment", "statefulset"]);
  });

  it("sorts operational numeric columns", () => {
    const rows = [
      workload({ name: "old", age_seconds: 3_600, restart_count: 1, cpu_milli: 50, mem_bytes: 512 }),
      workload({ name: "new", age_seconds: 60, restart_count: 7, cpu_milli: 200, mem_bytes: 256 }),
    ];

    expect(sortWorkloads(rows, { key: "age", direction: "asc" })[0].name).toBe("new");
    expect(sortWorkloads(rows, { key: "restarts", direction: "desc" })[0].name).toBe("new");
    expect(sortWorkloads(rows, { key: "cpu", direction: "desc" })[0].name).toBe("new");
    expect(sortWorkloads(rows, { key: "memory", direction: "desc" })[0].name).toBe("old");
  });

  it("keeps missing metric values last for ascending and descending sorts", () => {
    const rows = [
      workload({ name: "missing" }),
      workload({ name: "low", cpu_milli: 25 }),
      workload({ name: "high", cpu_milli: 250 }),
    ];

    expect(sortWorkloads(rows, { key: "cpu", direction: "asc" }).map((w) => w.name)).toEqual([
      "low",
      "high",
      "missing",
    ]);
    expect(sortWorkloads(rows, { key: "cpu", direction: "desc" }).map((w) => w.name)).toEqual([
      "high",
      "low",
      "missing",
    ]);
  });

  it("keeps triage-risk ordering when no explicit sort is chosen", () => {
    const rows = [
      workload({ name: "healthy", health: "healthy" }),
      workload({ name: "failed", health: "failed" }),
      workload({ name: "degraded", health: "degraded" }),
    ];

    expect(sortWorkloads(rows, null).map((w) => w.name)).toEqual([
      "failed",
      "degraded",
      "healthy",
    ]);
  });
});

describe("workload selection helpers", () => {
  it("builds stable workload selection keys and visible key sets", () => {
    const rows = [
      workload({ kind: "pod", namespace: "default", name: "api-1" }),
      workload({ kind: "deployment", namespace: "platform", name: "api" }),
    ];

    expect(workloadSelectionKey(rows[0])).toBe("pod/default/api-1");
    expect(selectVisibleWorkloadKeys(rows)).toEqual(
      new Set(["pod/default/api-1", "deployment/platform/api"]),
    );
  });

  it("filters restart-eligible controller workloads", () => {
    const rows = [
      workload({ kind: "pod", name: "api-1" }),
      workload({ kind: "deployment", name: "api" }),
      workload({ kind: "statefulset", name: "db" }),
      workload({ kind: "daemonset", name: "agent" }),
      workload({ kind: "job", name: "batch" }),
    ];

    expect(restartEligibleWorkloads(rows).map((w) => w.name)).toEqual([
      "api",
      "db",
      "agent",
    ]);
  });

  it("formats selected workload context for the AI assistant", () => {
    const context = buildSelectedWorkloadsAiContext("prod", [
      workload({
        kind: "pod",
        namespace: "checkout",
        name: "api-7b9",
        health: "degraded",
        ready: "0/1",
        pod_phase: "Pending",
        restart_count: 3,
        node_name: "node-a",
        cpu_milli: 120,
        mem_bytes: 2048,
      }),
    ]);

    expect(context).toContain("selected_workload_resources:");
    expect(context).toContain("- pod/checkout/api-7b9");
    expect(context).toContain("cluster=prod");
    expect(context).toContain("health=degraded");
    expect(context).toContain("restarts=3");
  });
});
