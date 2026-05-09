import { describe, expect, it } from "vitest";
import type { NodeSummary, WorkloadSummary } from "@/lib/k8s";
import type { NetworkDebugSnapshot } from "@/lib/networkDebugger";
import {
  buildAlertInbox,
  summarizeAlertsBySeverity,
  type AlertInboxEvent,
  type AlertInboxInput,
} from "./alertInbox";

function workload(overrides: Partial<WorkloadSummary>): WorkloadSummary {
  return {
    kind: "pod",
    name: "api-7b9",
    namespace: "checkout",
    ready: "1/1",
    age_seconds: 600,
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

function warning(overrides: Partial<AlertInboxEvent>): AlertInboxEvent {
  return {
    ts: "2026-05-09T10:00:00Z",
    kind: "Pod",
    reason: "FailedScheduling",
    message: "0/3 nodes are available: insufficient cpu",
    involved: "Pod/api-7b9",
    type_: "Warning",
    namespace: "checkout",
    ...overrides,
  };
}

function network(overrides: Partial<NetworkDebugSnapshot> = {}): NetworkDebugSnapshot {
  return {
    namespaces: [],
    pods: [],
    services: [],
    endpoints: [],
    endpointSlices: [],
    ingresses: [],
    networkPolicies: [],
    ...overrides,
  };
}

function build(input: Partial<AlertInboxInput> = {}) {
  return buildAlertInbox({
    context: "prod",
    workloads: [],
    nodes: [],
    events: [],
    network: undefined,
    nowMs: Date.parse("2026-05-09T10:30:00Z"),
    ...input,
  });
}

describe("buildAlertInbox", () => {
  it("evaluates deployment, pending pod, and failed job alert rules with operational evidence", () => {
    const alerts = build({
      workloads: [
        workload({
          kind: "deployment",
          name: "api",
          ready: "0/3",
          health: "degraded",
        }),
        workload({
          name: "api-7b9",
          pod_phase: "Pending",
          ready: "0/1",
          age_seconds: 1_800,
        }),
        workload({
          kind: "job",
          name: "nightly-import",
          ready: "0/1",
          health: "failed",
        }),
      ],
    });

    expect(alerts.map((alert) => alert.ruleId)).toEqual([
      "deployment-unavailable",
      "job-failed",
      "pod-pending-too-long",
    ]);
    expect(alerts[0]).toMatchObject({
      severity: "critical",
      title: "Deployment unavailable",
      resource: { kind: "deployment", namespace: "checkout", name: "api" },
      firstSeenMs: Date.parse("2026-05-09T10:20:00Z"),
      lastSeenMs: Date.parse("2026-05-09T10:30:00Z"),
    });
    expect(alerts[0].evidence).toContain("ready 0/3");
    expect(alerts[0].nextChecks).toContain("Open the deployment and inspect rollout conditions");
    expect(alerts[2].evidence).toContain("pending for 30m");
  });

  it("detects pod restart increases from a previous local sample and dedupes by fingerprint", () => {
    const alerts = build({
      previousRestartCounts: {
        "pod:checkout/api-7b9": 2,
      },
      workloads: [
        workload({
          name: "api-7b9",
          restart_count: 5,
          container_count: 2,
          container_ready_count: 1,
          pod_phase: "Running",
        }),
        workload({
          name: "api-7b9",
          restart_count: 5,
          pod_phase: "Running",
        }),
      ],
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      ruleId: "pod-restart-increase",
      fingerprint: "pod-restart-increase:pod:checkout/api-7b9",
      severity: "high",
      resource: { kind: "pod", namespace: "checkout", name: "api-7b9" },
    });
    expect(alerts[0].evidence).toContain("restarts increased by 3 since last sample");
    expect(alerts[0].evidence).toContain("5 total restarts");
  });

  it("groups warning event spikes by involved resource, reason, and rolling window", () => {
    const alerts = build({
      warningSpikeThreshold: 3,
      warningSpikeWindowMs: 10 * 60_000,
      events: [
        warning({ ts: "2026-05-09T10:29:00Z" }),
        warning({ ts: "2026-05-09T10:27:00Z", message: "still insufficient cpu" }),
        warning({ ts: "2026-05-09T10:22:00Z", message: "preemption not helpful" }),
        warning({ ts: "2026-05-09T09:00:00Z", message: "too old" }),
      ],
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      ruleId: "warning-event-spike",
      fingerprint: "warning-event-spike:pod:checkout/api-7b9:FailedScheduling",
      severity: "medium",
      eventCount: 3,
    });
    expect(alerts[0].firstSeenMs).toBe(Date.parse("2026-05-09T10:22:00Z"));
    expect(alerts[0].lastSeenMs).toBe(Date.parse("2026-05-09T10:29:00Z"));
  });

  it("flags not-ready nodes, pressure, and risky service exposure when network data is available", () => {
    const alerts = build({
      nodes: [
        node({ name: "node-b", ready: false }),
        node({
          name: "node-c",
          taints: ["node.kubernetes.io/disk-pressure:NoSchedule"],
          mem_usage_bytes: 14 * 1024 * 1024 * 1024,
        }),
      ],
      network: network({
        services: [
          {
            name: "public-api",
            namespace: "checkout",
            type: "LoadBalancer",
            selector: { app: "api" },
            ports: [{ port: 443, targetPort: 8443, protocol: "TCP" }],
          },
        ],
      }),
    });

    expect(alerts.map((alert) => alert.ruleId)).toEqual([
      "node-not-ready",
      "node-pressure",
      "risky-service-exposure",
    ]);
    expect(alerts[2]).toMatchObject({
      severity: "medium",
      resource: { kind: "service", namespace: "checkout", name: "public-api" },
    });
    expect(alerts[2].evidence).toContain("service type LoadBalancer");
    expect(summarizeAlertsBySeverity(alerts)).toEqual({
      critical: 1,
      high: 1,
      medium: 1,
      low: 0,
      info: 0,
    });
  });
});
