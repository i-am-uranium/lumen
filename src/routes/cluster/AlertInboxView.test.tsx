import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { k8s, type NodeSummary, type WorkloadKind, type WorkloadSummary } from "@/lib/k8s";
import { useAlertInboxStore } from "@/state/alertInbox";
import { AlertInboxView } from "./AlertInboxView";

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
    networkDebugSnapshot: vi.fn(),
  },
}));

vi.mock("@/hooks/useK8sWatch", () => ({
  useK8sWatch: () => undefined,
}));

vi.mock("@/components/ResourceDetailDrawer", () => ({
  ResourceDetailDrawer: () => null,
}));

function workload(overrides: Partial<WorkloadSummary>): WorkloadSummary {
  return {
    kind: "job",
    name: "biometric-scan",
    namespace: "dev",
    ready: "0/1",
    age_seconds: 300,
    health: "failed",
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

function renderAlertInbox() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/cluster/prod/alerts"]}>
        <Routes>
          <Route path="/cluster/:ctx/alerts" element={<AlertInboxView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AlertInboxView", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    useAlertInboxStore.getState().reset();
    vi.mocked(k8s.listNodes).mockResolvedValue([node({})]);
    vi.mocked(k8s.networkDebugSnapshot).mockResolvedValue({
      namespaces: [],
      services: [],
      endpoints: [],
      endpointSlices: [],
      ingresses: [],
      networkPolicies: [],
      pods: [],
    });
    vi.mocked(k8s.listWorkloads).mockImplementation(async (_namespace, kind: WorkloadKind) =>
      kind === "job" ? [workload({})] : [],
    );
  });

  it("keeps operational alert actions but hides old AI assistant CTAs", async () => {
    renderAlertInbox();

    expect(await screen.findByText("Job failed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /logs/i })).toHaveAttribute(
      "href",
      "/cluster/prod/logs?ns=dev&kind=job&name=biometric-scan",
    );
    expect(screen.getByRole("link", { name: /events/i })).toHaveAttribute(
      "href",
      "/cluster/prod/events?ns=dev",
    );
    expect(screen.queryByRole("button", { name: /ask AI/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^AI$/i })).not.toBeInTheDocument();
  });
});
