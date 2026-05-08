import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clusterSwitchPath } from "@/components/ClusterSwitcher";
import { ClusterWorkspace } from "./ClusterWorkspace";
import { k8s, type ContextInfo } from "@/lib/k8s";
import { useClusterStore } from "@/state/cluster";

vi.mock("@/lib/k8s", () => ({
  k8s: {
    listContexts: vi.fn(),
    setContext: vi.fn(),
    detectArgocd: vi.fn(),
    detectTekton: vi.fn(),
  },
}));

vi.mock("@/components/PortForwardsChip", () => ({
  PortForwardsChip: () => null,
}));

function context(overrides: Partial<ContextInfo> & { name: string }): ContextInfo {
  return {
    cluster: `${overrides.name}-cluster`,
    user: `${overrides.name}-user`,
    namespace: "default",
    is_current: false,
    is_prod: false,
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderWorkspace(contexts: ContextInfo[]) {
  vi.mocked(k8s.listContexts).mockResolvedValue(contexts);
  vi.mocked(k8s.setContext).mockImplementation(async (name: string) => {
    const next = contexts.find((item) => item.name === name);
    if (!next) throw new Error(`missing context ${name}`);
    return next;
  });
  vi.mocked(k8s.detectArgocd).mockResolvedValue(false);
  vi.mocked(k8s.detectTekton).mockResolvedValue(false);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/cluster/dev-stage/workloads/pods?ns=payments"]}>
        <Routes>
          <Route path="/cluster/:ctx" element={<ClusterWorkspace />}>
            <Route path="workloads/pods" element={<LocationProbe />} />
            <Route path="workloads" element={<LocationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("cluster switch routing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
    useClusterStore.setState({
      contextName: null,
      namespace: null,
      lastNamespaceByContext: {},
    });
  });

  it("preserves the active cluster section and query string", () => {
    expect(
      clusterSwitchPath(
        "/cluster/dev-stage/workloads/pods",
        "?ns=payments&q=api",
        "dev-stage",
        "prod-main",
      ),
    ).toBe("/cluster/prod-main/workloads/pods?ns=payments&q=api");
  });

  it("falls back to workloads when switching from the cluster root", () => {
    expect(clusterSwitchPath("/cluster/dev-stage", "", "dev-stage", "prod-main")).toBe(
      "/cluster/prod-main/workloads",
    );
  });

  it("does not duplicate the cluster switcher in the rail header", async () => {
    renderWorkspace([
      context({ name: "dev-stage" }),
      context({ name: "prod-main", is_prod: true }),
    ]);

    await screen.findByRole("complementary", { name: /cluster navigation/i });

    expect(screen.queryByRole("button", { name: /switch cluster/i })).not.toBeInTheDocument();
  });
});
