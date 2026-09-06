import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useK8sWatch } from "@/hooks/useK8sWatch";
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
  useK8sWatch: vi.fn(),
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

const scopeState = vi.hoisted(() => ({ loading: false, discoveryError: null as unknown }));
vi.mock("@/hooks/useNamespaceScope", () => ({
  useNamespaceScope: (_context: string, requested: string | null) => ({ namespace: requested ?? "", namespaces: [], discoveryError: scopeState.discoveryError, isLoading: scopeState.loading, setNamespace: vi.fn() }),
}));

function renderTriage(entry = "/cluster/prod/triage") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Link to="/cluster/stage/triage?ns=other">switch scope</Link>
        <Routes>
          <Route path="/cluster/:ctx/triage" element={<TriageView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TriageView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopeState.loading = false;
    scopeState.discoveryError = null;
    vi.mocked(invoke).mockResolvedValue(undefined);
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

  it("retains scoped workload issues when Node access is forbidden", async () => {
    scopeState.discoveryError = new Error("namespaces forbidden");
    vi.mocked(k8s.listNodes).mockRejectedValue(new Error("nodes forbidden"));
    vi.mocked(k8s.listWorkloads).mockImplementation(async (_ns, kind) => kind === "pod" ? [workload({ namespace: "payments", restart_count: 5, health: "degraded" })] : []);
    renderTriage("/cluster/prod/triage?ns=payments");
    expect(await screen.findByText("Pod restarting repeatedly")).toBeInTheDocument();
    expect(screen.getByText(/partial data/i)).toBeInTheDocument();
    expect(k8s.listWorkloads).toHaveBeenCalledWith("payments", "pod", "prod");
    expect(useK8sWatch).toHaveBeenCalledWith(expect.objectContaining({ args: { context: "prod", namespace: "payments" } }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stream_events", expect.objectContaining({ namespace: "payments", context: "prod" })));
    expect(screen.getByRole("button", { name: /investigate pod/i })).toBeInTheDocument();
  });

  it("does not start broad workload requests while default namespace is unresolved", () => {
    scopeState.loading = true;
    renderTriage();
    expect(screen.getByRole("button", { name: /^refresh$/i })).toBeDisabled();
    expect(k8s.listWorkloads).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("stream_events", expect.anything());
    expect(useK8sWatch).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("ignores events and drawer selection from the previous context", async () => {
    vi.mocked(k8s.listWorkloads).mockImplementation(async (_ns, kind, context) => context === "prod" && kind === "pod" ? [workload({ restart_count: 5, health: "degraded" })] : []);
    renderTriage("/cluster/prod/triage?ns=payments");
    await screen.findByText("Pod restarting repeatedly");
    await userEvent.click(screen.getByRole("button", { name: /open pod/i }));
    const old = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "stream_events")![1] as { streamId: string; channel: { onmessage: (value: unknown) => void } };
    await userEvent.click(screen.getByRole("link", { name: "switch scope" }));
    await waitFor(() => expect(k8s.listWorkloads).toHaveBeenCalledWith("other", "pod", "stage"));
    act(() => old.channel.onmessage({ type_: "Warning", involved: "Pod/stale-api", reason: "BackOff", message: "old failure", ts: null, kind: "Event" }));
    expect(screen.queryByTestId("drawer")).not.toBeInTheDocument();
    expect(screen.queryByText(/stale-api/)).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("stop_stream", { streamId: old.streamId });
  });

  it("labels unavailable sources without claiming a healthy cluster", async () => {
    vi.mocked(k8s.listNodes).mockRejectedValue(new Error("forbidden"));
    renderTriage();
    expect(await screen.findByText(/No issues found in available sources/i)).toBeInTheDocument();
    expect(screen.queryByText(/Cluster looks quiet/i)).not.toBeInTheDocument();
  });

  it("keeps warning availability unverified after a successful stream startup and in exports", async () => {
    vi.mocked(k8s.listWorkloads).mockImplementation(async (_ns, kind) => kind === "pod" ? [workload({ restart_count: 5 })] : []);
    renderTriage();
    await screen.findByText("Pod restarting repeatedly");
    expect(screen.getByText(/Live warning event availability is unverified/i)).toBeInTheDocument();
    expect(screen.getByText(/Received only; completeness unverified/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^export report$/i }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Live warning event availability is unverified");
    expect(screen.getByRole("dialog")).toHaveTextContent("Zero received events does not establish that no warnings exist");
  });

  it("keeps existing workload issues visible but waits for Nodes before exporting", async () => {
    let finishNodes!: (value: NodeSummary[]) => void;
    vi.mocked(k8s.listNodes).mockReturnValue(new Promise((resolve) => { finishNodes = resolve; }));
    vi.mocked(k8s.listWorkloads).mockImplementation(async (_ns, kind) => kind === "pod" ? [workload({ restart_count: 5 })] : []);
    renderTriage();
    await screen.findByText("Pod restarting repeatedly");
    expect(screen.getByText(/Node checks pending/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^export report$/i })).toBeDisabled();
    expect(screen.queryByText("No critical issues")).not.toBeInTheDocument();
    act(() => finishNodes([]));
    await waitFor(() => expect(screen.getByRole("button", { name: /^export report$/i })).not.toBeDisabled());
    expect(screen.queryByText(/Node checks pending/i)).not.toBeInTheDocument();
  });

  it("shows a useful empty state when no issues are classified", async () => {
    renderTriage();

    expect(await screen.findByText(/No active triage issues/i)).toBeInTheDocument();
    expect(screen.queryByText(/Cluster looks quiet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Warning stream availability remains unverified/i)).toBeInTheDocument();
  });
});
