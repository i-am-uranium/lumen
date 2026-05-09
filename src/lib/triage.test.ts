import { describe, expect, it } from "vitest";
import type { EventLine, NodeSummary, WorkloadSummary } from "@/lib/k8s";
import {
  buildTriageIssues,
  triageIssueCountsBySeverity,
  triageResourceKey,
  type TriageInput,
} from "./triage";

function workload(overrides: Partial<WorkloadSummary>): WorkloadSummary {
  return {
    kind: "pod",
    name: "api-7b9",
    namespace: "checkout",
    ready: "1/1",
    age_seconds: 1_200,
    health: "healthy",
    labels: {},
    ...overrides,
  };
}

function node(overrides: Partial<NodeSummary>): NodeSummary {
  return {
    name: "node-a",
    roles: ["worker"],
    version: "v1.31.0",
    ready: true,
    os_image: "Linux",
    arch: "arm64",
    cpu_capacity_milli: 4_000,
    mem_capacity_bytes: 16 * 1024 * 1024 * 1024,
    pods_capacity: 110,
    cpu_allocatable_milli: 3_800,
    mem_allocatable_bytes: 15 * 1024 * 1024 * 1024,
    taints: [],
    age_seconds: 86_400,
    cpu_usage_milli: 500,
    mem_usage_bytes: 2 * 1024 * 1024 * 1024,
    unschedulable: false,
    ...overrides,
  };
}

function warningEvent(overrides: Partial<EventLine>): EventLine {
  return {
    ts: "2026-05-09T10:00:00Z",
    kind: "Pod",
    reason: "BackOff",
    message: "Back-off restarting failed container api in pod api-7b9",
    involved: "Pod/api-7b9",
    type_: "Warning",
    ...overrides,
  };
}

function build(overrides: Partial<TriageInput> = {}) {
  return buildTriageIssues({
    context: "prod",
    workloads: [],
    nodes: [],
    events: [],
    ...overrides,
  });
}

describe("buildTriageIssues", () => {
  it("groups restarted pods as crashloop/restart issues with next checks", () => {
    const issues = build({
      workloads: [
        workload({
          name: "api-7b9",
          restart_count: 6,
          container_count: 2,
          container_ready_count: 1,
          pod_phase: "Running",
          health: "degraded",
        }),
      ],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      group: "crashloop-restarts",
      severity: "high",
      title: "Pod restarting repeatedly",
      resource: { kind: "pod", namespace: "checkout", name: "api-7b9" },
    });
    expect(issues[0].evidence).toContain("6 container restarts");
    expect(issues[0].nextActions).toContain("Open logs for the failing container");
  });

  it("classifies pending pods and failed jobs separately", () => {
    const issues = build({
      workloads: [
        workload({ name: "worker-0", pod_phase: "Pending", ready: "0/1" }),
        workload({
          kind: "job",
          name: "nightly-import",
          ready: "0/1",
          health: "failed",
        }),
      ],
    });

    expect(issues.map((issue) => issue.group)).toEqual([
      "failed-workloads",
      "pending-pods",
    ]);
    expect(issues[0].title).toBe("Job failed");
    expect(issues[1].nextActions).toContain("Check scheduling events and PVC bindings");
  });

  it("surfaces warning events and links them to involved resources when possible", () => {
    const issues = build({
      events: [
        warningEvent({ involved: "Deployment/api", kind: "Deployment" }),
        warningEvent({ type_: "Normal", reason: "Pulled" }),
      ],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      group: "warning-events",
      severity: "medium",
      resource: { kind: "deployment", namespace: null, name: "api" },
    });
    expect(issues[0].evidence).toContain("BackOff: Back-off restarting failed container api in pod api-7b9");
  });

  it("flags not-ready nodes, pressure taints, and high resource use", () => {
    const issues = build({
      nodes: [
        node({
          name: "node-b",
          ready: false,
          taints: ["node.kubernetes.io/memory-pressure:NoSchedule"],
          cpu_usage_milli: 3_600,
          mem_usage_bytes: 14 * 1024 * 1024 * 1024,
        }),
      ],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      group: "node-health",
      severity: "critical",
      title: "Node not ready",
      resource: { kind: "node", namespace: null, name: "node-b" },
    });
    expect(issues[0].evidence.join(" ")).toContain("memory-pressure");
    expect(issues[0].evidence.join(" ")).toContain("cpu 95%");
    expect(issues[0].nextActions).toContain("Inspect node conditions and recent warning events");
  });

  it("flags degraded controller readiness without duplicating pods", () => {
    const issues = build({
      workloads: [
        workload({
          kind: "deployment",
          name: "api",
          ready: "1/3",
          health: "degraded",
        }),
      ],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      group: "degraded-controllers",
      severity: "medium",
      title: "Deployment degraded",
    });
    expect(issues[0].evidence).toContain("ready 1/3");
    expect(issues[0].nextActions).toContain("Open owned pods and compare desired vs ready replicas");
  });

  it("summarizes severity counts and builds stable resource keys", () => {
    const issues = build({
      workloads: [
        workload({ name: "failed", pod_phase: "Failed", health: "failed" }),
        workload({ name: "pending", pod_phase: "Pending" }),
      ],
      nodes: [node({ name: "node-b", ready: false })],
    });

    expect(triageIssueCountsBySeverity(issues)).toEqual({
      critical: 1,
      high: 1,
      medium: 1,
      low: 0,
    });
    expect(triageResourceKey(issues[0].resource)).toBe("node//node-b");
  });
});
