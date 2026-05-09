import { describe, expect, it } from "vitest";
import type { MetricsExplorerSnapshot } from "@/lib/k8s";
import {
  classifyPressure,
  formatCpu,
  formatMemory,
  parseCpuQuantity,
  parseMemoryQuantity,
  summarizeMetricsExplorer,
  utilizationPercent,
} from "./metricsExplorer";

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
        cpu_allocatable_milli: 4_000,
        mem_allocatable_bytes: 16 * GiB,
        cpu_usage_milli: 1_000,
        mem_usage_bytes: 4 * GiB,
      },
      {
        name: "node-b",
        ready: true,
        cpu_allocatable_milli: 2_000,
        mem_allocatable_bytes: 8 * GiB,
        cpu_usage_milli: 1_600,
        mem_usage_bytes: 7 * GiB,
      },
    ],
    pods: [
      {
        namespace: "payments",
        name: "api-7d9",
        node_name: "node-a",
        workload_kind: "Deployment",
        workload_name: "api",
        cpu_usage_milli: 500,
        mem_usage_bytes: 768 * MiB,
        cpu_request_milli: 250,
        cpu_limit_milli: 1_000,
        mem_request_bytes: 512 * MiB,
        mem_limit_bytes: 1024 * MiB,
      },
      {
        namespace: "payments",
        name: "worker-0",
        node_name: "node-b",
        workload_kind: "StatefulSet",
        workload_name: "worker",
        cpu_usage_milli: 1_200,
        mem_usage_bytes: 3 * GiB,
        cpu_request_milli: 1_000,
        cpu_limit_milli: null,
        mem_request_bytes: 2 * GiB,
        mem_limit_bytes: null,
      },
      {
        namespace: "observability",
        name: "prometheus-0",
        node_name: "node-b",
        workload_kind: "Pod",
        workload_name: "prometheus-0",
        cpu_usage_milli: null,
        mem_usage_bytes: null,
        cpu_request_milli: 2_000,
        cpu_limit_milli: 2_000,
        mem_request_bytes: 4 * GiB,
        mem_limit_bytes: 6 * GiB,
      },
    ],
    ...overrides,
  };
}

describe("metrics quantity helpers", () => {
  it("parses Kubernetes CPU and memory quantities", () => {
    expect(parseCpuQuantity("250m")).toBe(250);
    expect(parseCpuQuantity("1.5")).toBe(1500);
    expect(parseCpuQuantity("125000000n")).toBe(125);
    expect(parseCpuQuantity("bad")).toBeNull();

    expect(parseMemoryQuantity("512Mi")).toBe(512 * MiB);
    expect(parseMemoryQuantity("1.5Gi")).toBe(Math.round(1.5 * GiB));
    expect(parseMemoryQuantity("1000M")).toBe(1_000_000_000);
    expect(parseMemoryQuantity("bad")).toBeNull();
  });

  it("formats operational metric values compactly", () => {
    expect(formatCpu(375)).toBe("375m");
    expect(formatCpu(1530)).toBe("1.53 cores");
    expect(formatMemory(768 * MiB)).toBe("768 MiB");
    expect(formatMemory(3 * GiB)).toBe("3 GiB");
    expect(utilizationPercent(75, 300)).toBe(25);
    expect(utilizationPercent(1, 0)).toBeNull();
  });
});

describe("metrics explorer summarization", () => {
  it("rolls up cluster, namespace, workload, pod, and node pressure", () => {
    const summary = summarizeMetricsExplorer(snapshot());

    expect(summary.cluster.cpu.used).toBe(2_600);
    expect(summary.cluster.cpu.requested).toBe(3_250);
    expect(summary.cluster.cpu.allocatable).toBe(6_000);
    expect(summary.cluster.memory.requested).toBe(6.5 * GiB);
    expect(summary.cluster.cpu.pressure).toBe("low");

    expect(summary.namespaces.map((ns) => ns.namespace)).toEqual([
      "observability",
      "payments",
    ]);
    expect(summary.namespaces.find((ns) => ns.namespace === "payments")?.cpu.used).toBe(1_700);
    expect(summary.topPodsByCpu.map((pod) => pod.name)).toEqual(["worker-0", "api-7d9"]);
    expect(summary.topWorkloadsByMemory.map((row) => `${row.namespace}/${row.name}`)).toEqual([
      "observability/prometheus-0",
      "payments/worker",
      "payments/api",
    ]);
    expect(summary.nodesByMemoryPressure[0]).toMatchObject({
      name: "node-b",
      memoryPressure: "high",
    });
  });

  it("filters by namespace/search and classifies unavailable metric coverage", () => {
    const summary = summarizeMetricsExplorer(snapshot(), {
      namespace: "payments",
      search: "worker",
    });

    expect(summary.filteredPods.map((pod) => pod.name)).toEqual(["worker-0"]);
    expect(summary.dataState).toBe("ready");

    const unavailable = summarizeMetricsExplorer(
      snapshot({
        nodes: snapshot().nodes.map((node) => ({
          ...node,
          cpu_usage_milli: null,
          mem_usage_bytes: null,
        })),
        pods: snapshot().pods.map((pod) => ({
          ...pod,
          cpu_usage_milli: null,
          mem_usage_bytes: null,
        })),
      }),
    );
    expect(unavailable.dataState).toBe("metrics-unavailable");
    expect(classifyPressure(null)).toBe("unknown");
    expect(classifyPressure(92)).toBe("critical");
  });
});
