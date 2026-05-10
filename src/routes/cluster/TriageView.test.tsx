import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TriageView } from "./TriageView";
import { k8s, type NodeSummary, type WorkloadKind, type WorkloadSummary } from "@/lib/k8s";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class Channel<T> {
    onmessage: ((message: T) => void) | null = null;
  },
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/k8s", () => ({
  k8s: {
    listWorkloads: vi.fn(),
    listNodes: vi.fn(),
  },
}));

vi.mock("@/hooks/useK8sWatch", () => ({
  useK8sWatch: () => undefined,
}));

vi.mock("@/components/ResourceDetailDrawer", () => ({
  ResourceDetailDrawer: ({
    resource,
  }: {
    resource: { kind: string; namespace: string; name: string } | null;
  }) =>
    resource ? (
      <div data-testid="drawer">
        drawer:{resource.kind}/{resource.namespace}/{resource.name}
      </div>
    ) : null,
}));

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

function renderTriage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/cluster/prod/triage"]}>
        <Routes>
          <Route path="/cluster/:ctx/triage" element={<TriageView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TriageView", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(k8s.listNodes).mockResolvedValue([]);
    vi.mocked(k8s.listWorkloads).mockResolvedValue([]);
  });

  it("renders triage issues with logs links and opens the resource drawer", async () => {
    vi.mocked(k8s.listWorkloads).mockImplementation(
      async (_namespace: string, kind: WorkloadKind) => {
        if (kind === "pod") {
          return [
            workload({
              restart_count: 4,
              container_count: 1,
              container_ready_count: 0,
              health: "degraded",
              pod_phase: "Running",
            }),
          ];
        }
        return [];
      },
    );
    vi.mocked(k8s.listNodes).mockResolvedValue([node({ name: "node-a" })]);

    renderTriage();

    expect(await screen.findByText("Pod restarting repeatedly")).toBeInTheDocument();
    const logsLink = screen.getByRole("link", { name: /logs/i });
    expect(logsLink).toHaveAttribute(
      "href",
      "/cluster/prod/logs?ns=checkout&kind=pod&name=api-7b9",
    );
    expect(screen.getByRole("link", { name: /events/i })).toHaveAttribute(
      "href",
      "/cluster/prod/events?ns=checkout",
    );
    expect(screen.queryByRole("button", { name: /ask AI/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^AI$/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /open pod\/api-7b9/i }));

    expect(screen.getByTestId("drawer")).toHaveTextContent("drawer:pod/checkout/api-7b9");
  });

  it("shows a useful empty state when no issues are classified", async () => {
    renderTriage();

    expect(await screen.findByText(/No active triage issues/i)).toBeInTheDocument();
    expect(screen.getByText(/Cluster looks quiet from workloads, nodes, and streamed warnings/i)).toBeInTheDocument();
  });
});
