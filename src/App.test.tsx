import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { k8s, type ContextInfo } from "@/lib/k8s";
import { useClusterStore } from "@/state/cluster";
import { usePanesStore } from "@/state/panes";
import { useTabsStore } from "@/state/tabs";

const activityStream = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  unreadWarnings: 0,
  context: null as string | null,
}));

vi.mock("@/lib/k8s", () => ({
  k8s: {
    listContexts: vi.fn(),
    setContext: vi.fn(),
    listNamespaces: vi.fn(),
    listWorkloads: vi.fn(),
    detectArgocd: vi.fn(),
    detectTekton: vi.fn(),
  },
}));

vi.mock("@/lib/autoUpdater", () => ({
  checkForAppUpdate: vi.fn(),
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));

vi.mock("@/components/ActivityDrawer", () => ({
  ActivityDrawer: () => null,
}));

vi.mock("@/state/activityStream", () => ({
  useActivityStream: (selector: (state: typeof activityStream) => unknown) =>
    selector(activityStream),
}));

vi.mock("@/routes/cluster/ClusterWorkspace", () => ({
  ClusterWorkspace: () => <div data-testid="workspace" />,
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

describe("top cluster switcher", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
    window.history.pushState({}, "", "/cluster/dev-stage/workloads/pods?ns=payments");
    useClusterStore.setState({
      contextName: "dev-stage",
      namespace: null,
      lastNamespaceByContext: {},
    });
    // Seed the panes store from window.location so the focused pane
    // matches the URL the test pre-pushed. (Module load fires before
    // beforeEach, so the persisted default seed is `/cluster` —
    // without this reset the NavBar would render the static badge.)
    const paneId = "test-pane";
    usePanesStore.setState({
      panes: [{ id: paneId, url: window.location.pathname + window.location.search }],
      focusedId: paneId,
      sizes: [100],
      orientation: "horizontal",
    });
    useTabsStore.getState().reset();
  });

  it("replaces the static CLUSTER badge and preserves the route when switching", async () => {
    const contexts = [
      context({ name: "dev-stage", cluster: "dev-cluster" }),
      context({ name: "prod-main", cluster: "prod-cluster", is_prod: true }),
    ];
    vi.mocked(k8s.listContexts).mockResolvedValue(contexts);
    vi.mocked(k8s.setContext).mockImplementation(async (name: string) => {
      const next = contexts.find((item) => item.name === name);
      if (!next) throw new Error(`missing context ${name}`);
      return next;
    });
    vi.mocked(k8s.detectArgocd).mockResolvedValue(false);
    vi.mocked(k8s.detectTekton).mockResolvedValue(false);

    render(<App />);

    const switcher = await screen.findByRole("button", { name: /switch cluster/i });
    expect(switcher).toHaveTextContent("dev-stage");
    expect(screen.queryByText("cluster", { selector: "span" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^AI$/i })).not.toBeInTheDocument();

    await userEvent.click(switcher);
    await userEvent.type(screen.getByPlaceholderText(/switch cluster/i), "prod");
    await userEvent.click(await screen.findByRole("option", { name: /prod-main/i }));

    expect(k8s.setContext).toHaveBeenCalledWith("prod-main");
    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe(
        "/cluster/prod-main/workloads/pods?ns=payments",
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /switch cluster/i })).toHaveTextContent(
        "prod-main",
      ),
    );
  });
});
