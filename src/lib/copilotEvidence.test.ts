import { describe, expect, it, vi } from "vitest";
import type { EventSummary, WorkloadSummary } from "@/lib/k8s";
import type { CopilotResolvedResource } from "./copilotResourceResolver";
import { collectCopilotEvidence } from "./copilotEvidence";

const target: CopilotResolvedResource = {
  id: "kubernetes:deployment:checkout:customer-service",
  kind: "deployment",
  namespace: "checkout",
  name: "customer-service",
  displayName: "deployment/checkout/customer-service",
  source: "kubernetes",
  score: 100,
  reasons: ["exact normalized name match"],
  health: "healthy",
  ready: "2/2",
};

function pod(
  name: string,
  restartCount: number,
  health: WorkloadSummary["health"] = "healthy",
): WorkloadSummary {
  return {
    kind: "pod",
    name,
    namespace: "checkout",
    ready: health === "healthy" ? "1/1" : "0/1",
    age_seconds: 120,
    health,
    labels: { "app.kubernetes.io/name": "customer-service" },
    restart_count: restartCount,
    container_count: 1,
    container_ready_count: health === "healthy" ? 1 : 0,
  };
}

function event(reason: string, type_ = "Warning"): EventSummary {
  return {
    ts: "2026-05-10T00:00:00Z",
    type_,
    reason,
    message: `${reason} on customer-service`,
    involved_kind: "Pod",
    involved_name: "customer-service-7f9d",
    count: 3,
  };
}

describe("collectCopilotEvidence", () => {
  it("summarizes pod readiness, restarts, warning events, and CTAs", async () => {
    const client = {
      listPodsFor: vi.fn(async () => [
        pod("customer-service-7f9d", 4, "degraded"),
        pod("customer-service-8abc", 0, "healthy"),
      ]),
      listEventsFor: vi.fn(async () => [event("BackOff")]),
    };

    const evidence = await collectCopilotEvidence(
      "stage",
      target,
      client,
      () => new Date("2026-05-10T00:00:00Z"),
    );

    expect(client.listPodsFor).toHaveBeenCalledWith(
      "checkout",
      "deployment",
      "customer-service",
      "stage",
    );
    expect(client.listEventsFor).toHaveBeenCalledWith(
      "checkout",
      "deployment",
      "customer-service",
      "stage",
    );
    expect(evidence.health).toBe("degraded");
    expect(evidence.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Pods", value: "2 total, 1 ready" }),
        expect.objectContaining({ label: "Restarts", value: "4 total" }),
      ]),
    );
    expect(evidence.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Highest restart count", value: "customer-service-7f9d: 4" }),
        expect.objectContaining({ label: "BackOff", detail: "BackOff on customer-service" }),
      ]),
    );
    expect(evidence.ctas.map((cta) => cta.label)).toEqual([
      "Open logs for customer-service",
      "Open related events",
      "Open workload",
    ]);
  });
});
