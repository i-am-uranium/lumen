import { describe, expect, it } from "vitest";
import type { MetricsExplorerSnapshot, PodDetails } from "@/lib/k8s";
import {
  buildGitOpsPatch,
  buildRecommendationPrSummary,
  recommendResourceChanges,
} from "./resourceRecommendations";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function snapshot(overrides: Partial<MetricsExplorerSnapshot> = {}): MetricsExplorerSnapshot {
  return {
    fetched_at_ms: 1_700_000_000_000,
    errors: [],
    nodes: [
      {
        name: "node-a",
        ready: true,
        cpu_allocatable_milli: 8_000,
        mem_allocatable_bytes: 32 * GiB,
        cpu_usage_milli: 1_500,
        mem_usage_bytes: 10 * GiB,
      },
    ],
    pods: [
      {
        namespace: "airflow",
        name: "scheduler-7d9",
        node_name: "node-a",
        workload_kind: "Deployment",
        workload_name: "scheduler",
        cpu_usage_milli: 120,
        mem_usage_bytes: 600 * MiB,
        cpu_request_milli: 2_000,
        cpu_limit_milli: 4_000,
        mem_request_bytes: 1024 * MiB,
        mem_limit_bytes: 2 * GiB,
      },
      {
        namespace: "kafka",
        name: "broker-0",
        node_name: "node-a",
        workload_kind: "StatefulSet",
        workload_name: "broker",
        cpu_usage_milli: 800,
        mem_usage_bytes: 5 * GiB,
        cpu_request_milli: 1_000,
        cpu_limit_milli: null,
        mem_request_bytes: 2 * GiB,
        mem_limit_bytes: null,
      },
      {
        namespace: "ops",
        name: "agent-a",
        node_name: "node-a",
        workload_kind: "DaemonSet",
        workload_name: "agent",
        cpu_usage_milli: 60,
        mem_usage_bytes: 128 * MiB,
        cpu_request_milli: null,
        cpu_limit_milli: null,
        mem_request_bytes: 128 * MiB,
        mem_limit_bytes: null,
      },
      {
        namespace: "default",
        name: "debug",
        node_name: "node-a",
        workload_kind: "Pod",
        workload_name: "debug",
        cpu_usage_milli: 5,
        mem_usage_bytes: 32 * MiB,
        cpu_request_milli: 500,
        cpu_limit_milli: 500,
        mem_request_bytes: 256 * MiB,
        mem_limit_bytes: 512 * MiB,
      },
    ],
    ...overrides,
  };
}

describe("resource recommendations", () => {
  it("ranks CPU reclaim before memory risk and unsupported pod insights", () => {
    const recommendations = recommendResourceChanges(snapshot());

    expect(recommendations.map((rec) => rec.signal)).toEqual([
      "cpu-downsize",
      "memory-risk",
      "missing-request",
      "missing-limit",
      "missing-limit",
      "cpu-downsize",
    ]);
    expect(recommendations[0]).toMatchObject({
      namespace: "airflow",
      workloadKind: "Deployment",
      workloadName: "scheduler",
      signal: "cpu-downsize",
      currentCpuRequestMilli: 2_000,
      recommendedCpuRequestMilli: 240,
      confidence: "high",
      supported: true,
    });
    expect(recommendations[1]).toMatchObject({
      namespace: "kafka",
      workloadKind: "StatefulSet",
      workloadName: "broker",
      signal: "memory-risk",
      currentMemoryRequestBytes: 2 * GiB,
      recommendedMemoryRequestBytes: 6.25 * GiB,
      supported: true,
    });
    expect(recommendations.find((rec) => rec.workloadKind === "Pod")).toMatchObject({
      supported: false,
      confidence: "low",
    });
  });

  it("builds GitOps patch text using sampled pod container names", () => {
    const [recommendation] = recommendResourceChanges(snapshot());
    const podDetails = {
      containers: [
        {
          name: "scheduler",
          image: "airflow:latest",
          ready: true,
          restart_count: 0,
          state: "running",
          cpu_request_milli: 2_000,
          cpu_limit_milli: 4_000,
          mem_request_bytes: 1024 * MiB,
          mem_limit_bytes: 2 * GiB,
        },
      ],
    } as PodDetails;

    expect(buildGitOpsPatch(recommendation, podDetails)).toContain("kind: Deployment");
    expect(buildGitOpsPatch(recommendation, podDetails)).toContain("namespace: airflow");
    expect(buildGitOpsPatch(recommendation, podDetails)).toContain("name: scheduler");
    expect(buildGitOpsPatch(recommendation, podDetails)).toContain("cpu: 240m");
    expect(buildGitOpsPatch(recommendation, podDetails)).toContain("Translate this patch into Helm values or Kustomize overlays");
  });

  it("builds a PR summary with caveats instead of claiming guaranteed savings", () => {
    const [recommendation] = recommendResourceChanges(snapshot());

    expect(buildRecommendationPrSummary(recommendation)).toContain("airflow/Deployment/scheduler");
    expect(buildRecommendationPrSummary(recommendation)).toContain("potential CPU request reduction");
    expect(buildRecommendationPrSummary(recommendation)).toContain("not a guaranteed node count reduction");
  });
});
