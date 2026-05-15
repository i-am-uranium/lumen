import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { MetricsExplorerView } from "./MetricsExplorerView";
import { k8s, type MetricsExplorerSnapshot, type PodDetails } from "@/lib/k8s";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/components/ResourceDetailDrawer", () => ({
  ResourceDetailDrawer: () => null,
}));

vi.mock("@/lib/k8s", async () => {
  const actual = await vi.importActual<typeof import("@/lib/k8s")>("@/lib/k8s");
  return {
    ...actual,
    k8s: {
      ...actual.k8s,
      listNamespaces: vi.fn(),
      metricsExplorerSnapshot: vi.fn(),
      getPodDetails: vi.fn(),
    },
  };
});

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function snapshot(): MetricsExplorerSnapshot {
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
    ],
  };
}

function podDetails(): PodDetails {
  return {
    name: "scheduler-7d9",
    namespace: "airflow",
    status: "Running",
    qos_class: "Burstable",
    node_name: "node-a",
    controlled_by: { kind: "ReplicaSet", name: "scheduler-abc" },
    service_account: "default",
    pod_ip: "10.0.0.1",
    pod_ips: ["10.0.0.1"],
    conditions: [],
    tolerations: 0,
    labels: {},
    annotations: {},
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
    cpu_usage_milli: 120,
    mem_usage_bytes: 600 * MiB,
    age_seconds: 3600,
    created_at_ms: 1,
  };
}

function mockClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function renderMetrics() {
  vi.mocked(k8s.listNamespaces).mockResolvedValue(["airflow", "kafka"]);
  vi.mocked(k8s.metricsExplorerSnapshot).mockResolvedValue(snapshot());
  vi.mocked(k8s.getPodDetails).mockResolvedValue(podDetails());

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/cluster/prod/metrics"]}>
        <Routes>
          <Route path="/cluster/:ctx/metrics" element={<MetricsExplorerView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MetricsExplorerView recommendations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("renders recommendation summary and rows from the metrics snapshot", async () => {
    renderMetrics();

    expect(await screen.findByText("resource recommendations")).toBeInTheDocument();
    const region = screen.getByLabelText("resource recommendations");
    expect(screen.getByText("CPU reclaimable")).toBeInTheDocument();
    expect(within(region).getByText("airflow")).toBeInTheDocument();
    expect(within(region).getByText("Deployment/scheduler")).toBeInTheDocument();
    expect(within(region).getByText("cpu-downsize")).toBeInTheDocument();
    expect(within(region).getByText("memory-risk")).toBeInTheDocument();
  });

  it("filters recommendations by signal", async () => {
    renderMetrics();

    await screen.findByText("resource recommendations");
    fireEvent.change(screen.getByLabelText("recommendation signal"), {
      target: { value: "memory-risk" },
    });

    const region = screen.getByLabelText("resource recommendations");
    expect(within(region).queryByText("Deployment/scheduler")).not.toBeInTheDocument();
    expect(within(region).getByText("StatefulSet/broker")).toBeInTheDocument();
  });

  it("copies GitOps patch text using the sample pod containers", async () => {
    const writeText = mockClipboard();
    renderMetrics();

    await screen.findByText("resource recommendations");
    const region = screen.getByLabelText("resource recommendations");
    fireEvent.click(within(region).getAllByRole("button", { name: /copy gitops patch/i })[0]);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("kind: Deployment"));
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("cpu: 240m"));
    expect(k8s.getPodDetails).toHaveBeenCalledWith("prod", "airflow", "scheduler-7d9");
    expect(toast.success).toHaveBeenCalledWith("copied GitOps patch");
  });
});
