import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodesView } from "./NodesView";
import { k8s, type NodeSummary } from "@/lib/k8s";

vi.mock("@/hooks/useK8sWatch", () => ({
  useK8sWatch: vi.fn(),
}));

vi.mock("@/lib/k8s", () => ({
  k8s: {
    listNodes: vi.fn(),
  },
}));

function node(overrides: Partial<NodeSummary> = {}): NodeSummary {
  return {
    name: "ip-10-0-0-12",
    roles: ["worker"],
    version: "v1.30.2",
    ready: true,
    os_image: "Ubuntu 22.04",
    arch: "amd64",
    cpu_capacity_milli: 4_000,
    mem_capacity_bytes: 16 * 1024 * 1024 * 1024,
    pods_capacity: 110,
    cpu_allocatable_milli: 3_900,
    mem_allocatable_bytes: 15 * 1024 * 1024 * 1024,
    taints: [],
    age_seconds: 86_400,
    cpu_usage_milli: null,
    mem_usage_bytes: null,
    ...overrides,
  };
}

function renderNodes(nodes: NodeSummary[]) {
  vi.mocked(k8s.listNodes).mockResolvedValue(nodes);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/cluster/dev/nodes"]}>
        <Routes>
          <Route path="/cluster/:ctx/nodes" element={<NodesView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NodesView", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("explains when live node usage metrics are unavailable", async () => {
    renderNodes([node()]);

    expect(
      await screen.findByText(/metrics-server is unavailable/i),
    ).toBeInTheDocument();
    expect(screen.getByText("ip-10-0-0-12")).toBeInTheDocument();
    expect(screen.getByText("3.90")).toBeInTheDocument();
    expect(screen.getByText("15 GiB")).toBeInTheDocument();
  });
});
