import { describe, expect, it } from "vitest";
import {
  matchQuickFilters,
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
