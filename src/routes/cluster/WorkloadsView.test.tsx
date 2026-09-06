import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkloadsView,
  matchQuickFilters,
  restartEligibleWorkloads,
  selectVisibleWorkloadKeys,
  sortWorkloads,
  workloadSelectionKey,
  workloadRiskScore,
  type QuickFilter,
} from "./WorkloadsView";
import { LegacyAssistantRedirect } from "@/components/LegacyAssistantRedirect";
import { k8s, type WorkloadSummary } from "@/lib/k8s";
import { useK8sWatch } from "@/hooks/useK8sWatch";
import { useUiSettings } from "@/state/uiSettings";

vi.mock("@/hooks/useK8sWatch", () => ({
  useK8sWatch: vi.fn(),
}));

vi.mock("@/lib/k8s", async () => {
  const actual = await vi.importActual<typeof import("@/lib/k8s")>("@/lib/k8s");
  return {
    ...actual,
    k8s: {
      ...actual.k8s,
      listContexts: vi.fn(),
      listNamespaces: vi.fn(),
      listWorkloads: vi.fn(),
    },
  };
});

function workload(overrides: Partial<WorkloadSummary>): WorkloadSummary {
  return {
    kind: "deployment",
    name: "api",
    namespace: "default",
    ready: "1/1",
    age_seconds: 3600,
    health: "healthy",
    labels: {},
    ...overrides,
  };
}

describe("workload triage helpers", () => {
  it("scores failed and degraded workloads ahead of healthy resources", () => {
    expect(workloadRiskScore(workload({ health: "failed" }))).toBeLessThan(
      workloadRiskScore(workload({ health: "degraded" })),
    );
    expect(workloadRiskScore(workload({ health: "degraded" }))).toBeLessThan(
      workloadRiskScore(workload({ health: "healthy" })),
    );
  });

  it("scores restarted and non-running pods as triage risks", () => {
    const healthyPod = workload({ kind: "pod", pod_phase: "Running" });
    const restartedPod = workload({
      kind: "pod",
      pod_phase: "Running",
      restart_count: 1,
    });
    const pendingPod = workload({ kind: "pod", pod_phase: "Pending" });

    expect(workloadRiskScore(restartedPod)).toBeLessThan(
      workloadRiskScore(healthyPod),
    );
    expect(workloadRiskScore(pendingPod)).toBeLessThan(
      workloadRiskScore(healthyPod),
    );
  });

  it("matches quick filters against health, restarts, and pod phase", () => {
    const filters = new Set<QuickFilter>(["unhealthy", "restarts"]);

    expect(
      matchQuickFilters(
        workload({ health: "degraded", restart_count: 2 }),
        filters,
      ),
    ).toBe(true);
    expect(
      matchQuickFilters(
        workload({ health: "degraded", restart_count: 0 }),
        filters,
      ),
    ).toBe(false);
    expect(
      matchQuickFilters(
        workload({ health: "healthy", restart_count: 2 }),
        filters,
      ),
    ).toBe(false);
  });
});

describe("workload sorting helpers", () => {
  it("sorts by namespace, name, and kind", () => {
    const rows = [
      workload({ kind: "statefulset", namespace: "beta", name: "db" }),
      workload({ kind: "deployment", namespace: "alpha", name: "web" }),
      workload({ kind: "daemonset", namespace: "alpha", name: "agent" }),
    ];

    expect(
      sortWorkloads(rows, { key: "namespace", direction: "asc" }).map((w) =>
        `${w.namespace}/${w.name}`,
      ),
    ).toEqual(["alpha/agent", "alpha/web", "beta/db"]);
    expect(
      sortWorkloads(rows, { key: "name", direction: "desc" }).map((w) => w.name),
    ).toEqual(["web", "db", "agent"]);
    expect(
      sortWorkloads(rows, { key: "kind", direction: "asc" }).map((w) => w.kind),
    ).toEqual(["daemonset", "deployment", "statefulset"]);
  });

  it("sorts operational numeric columns", () => {
    const rows = [
      workload({ name: "old", age_seconds: 3_600, restart_count: 1, cpu_milli: 50, mem_bytes: 512 }),
      workload({ name: "new", age_seconds: 60, restart_count: 7, cpu_milli: 200, mem_bytes: 256 }),
    ];

    expect(sortWorkloads(rows, { key: "age", direction: "asc" })[0].name).toBe("new");
    expect(sortWorkloads(rows, { key: "restarts", direction: "desc" })[0].name).toBe("new");
    expect(sortWorkloads(rows, { key: "cpu", direction: "desc" })[0].name).toBe("new");
    expect(sortWorkloads(rows, { key: "memory", direction: "desc" })[0].name).toBe("old");
  });

  it("keeps missing metric values last for ascending and descending sorts", () => {
    const rows = [
      workload({ name: "missing" }),
      workload({ name: "low", cpu_milli: 25 }),
      workload({ name: "high", cpu_milli: 250 }),
    ];

    expect(sortWorkloads(rows, { key: "cpu", direction: "asc" }).map((w) => w.name)).toEqual([
      "low",
      "high",
      "missing",
    ]);
    expect(sortWorkloads(rows, { key: "cpu", direction: "desc" }).map((w) => w.name)).toEqual([
      "high",
      "low",
      "missing",
    ]);
  });

  it("keeps triage-risk ordering when no explicit sort is chosen", () => {
    const rows = [
      workload({ name: "healthy", health: "healthy" }),
      workload({ name: "failed", health: "failed" }),
      workload({ name: "degraded", health: "degraded" }),
    ];

    expect(sortWorkloads(rows, null).map((w) => w.name)).toEqual([
      "failed",
      "degraded",
      "healthy",
    ]);
  });
});

describe("workload selection helpers", () => {
  it("builds stable workload selection keys and visible key sets", () => {
    const rows = [
      workload({ kind: "pod", namespace: "default", name: "api-1" }),
      workload({ kind: "deployment", namespace: "platform", name: "api" }),
    ];

    expect(workloadSelectionKey(rows[0])).toBe("pod/default/api-1");
    expect(selectVisibleWorkloadKeys(rows)).toEqual(
      new Set(["pod/default/api-1", "deployment/platform/api"]),
    );
  });

  it("filters restart-eligible controller workloads", () => {
    const rows = [
      workload({ kind: "pod", name: "api-1" }),
      workload({ kind: "deployment", name: "api" }),
      workload({ kind: "statefulset", name: "db" }),
      workload({ kind: "daemonset", name: "agent" }),
      workload({ kind: "job", name: "batch" }),
    ];

    expect(restartEligibleWorkloads(rows).map((w) => w.name)).toEqual([
      "api",
      "db",
      "agent",
    ]);
  });

});

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current route">{location.pathname + location.search}</output>;
}

function renderWorkloads(
  items: WorkloadSummary[],
  initialEntry = "/cluster/dev/workloads/pod",
  contexts: ReturnType<typeof k8s.listContexts> = Promise.resolve([
    { name: "dev", cluster: "dev", user: "me", namespace: "payments", is_current: true, is_prod: false },
  ]),
) {
  vi.mocked(k8s.listContexts).mockReturnValue(contexts);
  vi.mocked(k8s.listNamespaces).mockResolvedValue([]);
  vi.mocked(k8s.listWorkloads).mockImplementation(async (_ns, kind) =>
    items.filter((w) => w.kind === kind),
  );

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <Routes>
          <Route path="/cluster/:ctx/ai" element={<LegacyAssistantRedirect />} />
          <Route
            path="/cluster/:ctx/workloads/:kind?"
            element={<WorkloadsView />}
          />
          <Route
            path="/cluster/:ctx/nodes"
            element={<div data-testid="nodes-route">nodes route</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function statCard(label: string): HTMLElement {
  const labelEl = screen.getByText(label, {
    selector: ".uppercase, .uppercase *, span, div",
  });
  const card = labelEl.closest('[role="button"]') as HTMLElement | null;
  if (!card) {
    throw new Error(`stat card "${label}" is not interactive`);
  }
  return card;
}

describe("WorkloadsView actionable stat cards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiSettings.setState({ selectedNamespaces: {} });
  });

  it("filters to restarting pods when the Restarts card is clicked and exposes the toggle via aria-pressed", async () => {
    renderWorkloads([
      workload({ kind: "pod", namespace: "default", name: "calm-pod", pod_phase: "Running" }),
      workload({
        kind: "pod",
        namespace: "default",
        name: "flapping-pod",
        pod_phase: "Running",
        restart_count: 5,
      }),
    ]);

    await waitFor(() => {
      expect(screen.getByText("calm-pod")).toBeInTheDocument();
      expect(screen.getByText("flapping-pod")).toBeInTheDocument();
    });

    const restartsCard = statCard("Restarts");
    expect(restartsCard).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(restartsCard);

    await waitFor(() => {
      expect(screen.queryByText("calm-pod")).not.toBeInTheDocument();
    });
    expect(screen.getByText("flapping-pod")).toBeInTheDocument();
    expect(statCard("Restarts")).toHaveAttribute("aria-pressed", "true");
  });

  it("filters to unhealthy resources when the At Risk card is clicked", async () => {
    renderWorkloads([
      workload({ kind: "pod", namespace: "default", name: "healthy-pod", pod_phase: "Running" }),
      workload({
        kind: "pod",
        namespace: "default",
        name: "broken-pod",
        health: "failed",
        pod_phase: "Failed",
      }),
    ]);

    await waitFor(() => {
      expect(screen.getByText("healthy-pod")).toBeInTheDocument();
    });

    fireEvent.click(statCard("At Risk"));

    await waitFor(() => {
      expect(screen.queryByText("healthy-pod")).not.toBeInTheDocument();
    });
    expect(screen.getByText("broken-pod")).toBeInTheDocument();
  });

  it("clears filters when the Resources card is clicked after a filter is applied", async () => {
    renderWorkloads([
      workload({ kind: "pod", namespace: "default", name: "calm-pod", pod_phase: "Running" }),
      workload({
        kind: "pod",
        namespace: "default",
        name: "flapping-pod",
        pod_phase: "Running",
        restart_count: 3,
      }),
    ]);

    await waitFor(() => expect(screen.getByText("calm-pod")).toBeInTheDocument());

    fireEvent.click(statCard("Restarts"));
    await waitFor(() => {
      expect(screen.queryByText("calm-pod")).not.toBeInTheDocument();
    });

    fireEvent.click(statCard("Resources"));
    await waitFor(() => {
      expect(screen.getByText("calm-pod")).toBeInTheDocument();
    });
    expect(screen.getByText("flapping-pod")).toBeInTheDocument();
    expect(statCard("Restarts")).toHaveAttribute("aria-pressed", "false");
  });

  it("navigates to the nodes route when the Nodes card is clicked", async () => {
    renderWorkloads([
      workload({
        kind: "pod",
        namespace: "default",
        name: "any-pod",
        pod_phase: "Running",
        node_name: "node-a",
      }),
    ]);

    await waitFor(() => expect(screen.getByText("any-pod")).toBeInTheDocument());

    fireEvent.click(statCard("Nodes"));

    await waitFor(() => {
      expect(screen.getByTestId("nodes-route")).toBeInTheDocument();
    });
  });
});

describe("WorkloadsView namespace scope and partial access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiSettings.setState({ selectedNamespaces: {} });
  });

  it("resolves the kubeconfig default before the first workload fetch", async () => {
    let resolveContexts!: (value: Awaited<ReturnType<typeof k8s.listContexts>>) => void;
    vi.mocked(k8s.listNamespaces).mockResolvedValue([]);
    vi.mocked(k8s.listWorkloads).mockResolvedValue([]);
    const contexts = new Promise<Awaited<ReturnType<typeof k8s.listContexts>>>((resolve) => { resolveContexts = resolve; });
    renderWorkloads([], "/cluster/dev/workloads/pod", contexts);

    expect(k8s.listWorkloads).not.toHaveBeenCalled();
    resolveContexts([
      { name: "dev", cluster: "dev", user: "me", namespace: "payments", is_current: true, is_prod: false },
    ]);

    await waitFor(() => expect(k8s.listWorkloads).toHaveBeenCalledWith("payments", "pod", "dev"));
  });

  it("keeps refresh disabled while namespace default resolution is pending", () => {
    const contexts = new Promise<Awaited<ReturnType<typeof k8s.listContexts>>>(() => {});
    renderWorkloads([], "/cluster/dev/workloads/pod", contexts);

    const refresh = screen.getByRole("button", { name: /refresh/i });
    expect(refresh).toBeDisabled();
    fireEvent.click(refresh);
    expect(k8s.listWorkloads).not.toHaveBeenCalled();
  });

  it("does not persist or query all namespaces after default resolution fails", async () => {
    renderWorkloads(
      [],
      "/cluster/dev/workloads/pod",
      Promise.reject(new Error("kubeconfig unreadable")),
    );

    await screen.findByText(/namespace discovery is unavailable/i);
    expect(k8s.listWorkloads).not.toHaveBeenCalled();
    expect(useUiSettings.getState().selectedNamespaces).not.toHaveProperty("dev");
    expect(screen.getByLabelText("current route")).toHaveTextContent("/cluster/dev/workloads/pod");
  });

  it("uses the same explicit namespace for list and watch calls", async () => {
    renderWorkloads([], "/cluster/dev/workloads/pod?ns=payments");

    await waitFor(() => expect(k8s.listWorkloads).toHaveBeenCalledWith("payments", "pod", "dev"));
    expect(vi.mocked(useK8sWatch)).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      args: { namespace: "payments", context: "dev" },
    }));
  });

  it("retains successful pod rows and reports partial data when deployments are forbidden", async () => {
    vi.mocked(k8s.listContexts).mockResolvedValue([
      { name: "dev", cluster: "dev", user: "me", namespace: "payments", is_current: true, is_prod: false },
    ]);
    vi.mocked(k8s.listNamespaces).mockResolvedValue(["payments"]);
    vi.mocked(k8s.listWorkloads).mockImplementation(async (_namespace, kind) => {
      if (kind === "deployment") throw new Error("deployments is forbidden");
      return kind === "pod" ? [workload({ kind: "pod", namespace: "payments", name: "api-pod" })] : [];
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/cluster/dev/workloads?ns=payments"]}>
          <Routes><Route path="/cluster/:ctx/workloads/:kind?" element={<WorkloadsView />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("api-pod")).toBeInTheDocument();
    expect(screen.getByText(/partial data/i)).toBeInTheDocument();
    expect(screen.getByText(/deployments is forbidden/i)).toBeInTheDocument();
  });
});


describe("retired assistant destination", () => {
  it("retains saved question and context after workloads normalizes and changes its filters", async () => {
    window.sessionStorage.setItem("saved-context", "operator evidence");
    renderWorkloads([
      workload({ name: "api", namespace: "payments" }),
      workload({ name: "web", namespace: "payments" }),
    ], "/cluster/dev/ai?namespace=payments&name=api&question=Why%3F&task=root-cause&aiContext=saved-context");
    await screen.findByText("api");
    const route = () => new URL(screen.getByLabelText("current route").textContent!, "https://local.invalid");
    expect(route().pathname).toBe("/cluster/dev/workloads");
    expect(route().searchParams.get("question")).toBe("Why?");
    expect(route().searchParams.get("task")).toBe("root-cause");
    expect(route().searchParams.get("aiContext")).toBe("saved-context");
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "web" } });
    await waitFor(() => expect(route().searchParams.get("q")).toBe("web"));
    expect(route().searchParams.get("question")).toBe("Why?");
    expect(route().searchParams.get("aiContext")).toBe("saved-context");
    expect(window.sessionStorage.getItem("saved-context")).toBe("operator evidence");
    window.sessionStorage.removeItem("saved-context");
  });
});
