import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SplitView } from "./SplitView";
import { usePanesStore } from "@/state/panes";
import { useTabsStore } from "@/state/tabs";

// Stub all heavy route components — we're testing the split/focus
// plumbing, not the individual views.
vi.mock("@/routes/cluster/FleetView", () => ({
  FleetView: () => <div data-testid="fleet" />,
}));
vi.mock("@/routes/cluster/ClusterWorkspace", () => ({
  ClusterWorkspace: () => <div data-testid="cluster-workspace" />,
}));
vi.mock("@/routes/Settings", () => ({
  Settings: () => <div data-testid="settings" />,
}));

beforeEach(() => {
  const a = "pane-a";
  const b = "pane-b";
  // Two panes side-by-side, A focused.
  usePanesStore.setState({
    panes: [
      { id: a, url: "/cluster/prod/workloads" },
      { id: b, url: "/cluster/staging/workloads" },
    ],
    focusedId: a,
    sizes: [50, 50],
    orientation: "horizontal",
  });
  useTabsStore.getState().reset();
});

describe("<SplitView />", () => {
  it("renders one pane per panesStore entry", async () => {
    render(<SplitView />);
    expect(await screen.findAllByTestId("cluster-workspace")).toHaveLength(2);
    // Each pane shows its own pane header in multi-pane mode.
    expect(screen.getAllByLabelText(/Close pane/)).toHaveLength(2);
  });

  it("clicking a pane focuses it (multi-pane chrome flips)", async () => {
    render(<SplitView />);
    await screen.findAllByTestId("cluster-workspace");
    // Initial focus is on pane A.
    expect(usePanesStore.getState().focusedId).toBe("pane-a");
    // Click pane B's chrome to focus it.
    const paneB = document.querySelector('[data-pane-id="pane-b"]') as HTMLElement;
    expect(paneB).not.toBeNull();
    await userEvent.click(paneB);
    expect(usePanesStore.getState().focusedId).toBe("pane-b");
  });

  it("close button removes the pane and reduces to single-pane mode", async () => {
    render(<SplitView />);
    await screen.findAllByTestId("cluster-workspace");
    const closeBtns = screen.getAllByLabelText(/Close pane/);
    await userEvent.click(closeBtns[1]);
    expect(usePanesStore.getState().panes).toHaveLength(1);
    expect(usePanesStore.getState().panes[0].id).toBe("pane-a");
    // Single-pane mode hides the pane chrome (the X buttons).
    expect(screen.queryAllByLabelText(/Close pane/)).toHaveLength(0);
  });

  it("each pane has its own independent tab strip", async () => {
    render(<SplitView />);
    await screen.findAllByTestId("cluster-workspace");
    // After mount, TabsSyncer seeds each pane with one tab at its URL.
    expect(useTabsStore.getState().byPane["pane-a"]?.tabs).toHaveLength(1);
    expect(useTabsStore.getState().byPane["pane-b"]?.tabs).toHaveLength(1);
    expect(useTabsStore.getState().byPane["pane-a"]?.tabs[0].url).toBe(
      "/cluster/prod/workloads",
    );
    expect(useTabsStore.getState().byPane["pane-b"]?.tabs[0].url).toBe(
      "/cluster/staging/workloads",
    );

    // Opening a tab in pane A shouldn't affect pane B's tabs.
    act(() => {
      useTabsStore.getState().openTab("pane-a", "/cluster/prod/logs");
    });
    expect(useTabsStore.getState().byPane["pane-a"]?.tabs).toHaveLength(2);
    expect(useTabsStore.getState().byPane["pane-b"]?.tabs).toHaveLength(1);
  });

  it("splitPane store action causes a new pane to mount with the focused pane's URL", () => {
    // Reset to a single pane first so we can observe the split.
    usePanesStore.setState({
      panes: [{ id: "only", url: "/cluster/prod/workloads" }],
      focusedId: "only",
      sizes: [100],
      orientation: "horizontal",
    });
    useTabsStore.getState().reset();
    render(<SplitView />);
    expect(usePanesStore.getState().panes).toHaveLength(1);
    act(() => {
      usePanesStore.getState().splitPane();
    });
    const state = usePanesStore.getState();
    expect(state.panes).toHaveLength(2);
    expect(state.panes[1].url).toBe("/cluster/prod/workloads");
    expect(state.focusedId).toBe(state.panes[1].id);
  });
});

describe("multi-pane navigation isolation", () => {
  it("navigating one pane via the store does not affect the other", async () => {
    render(<SplitView />);
    await screen.findAllByTestId("cluster-workspace");

    const before = usePanesStore.getState().panes.map((p) => p.url);
    expect(before).toEqual([
      "/cluster/prod/workloads",
      "/cluster/staging/workloads",
    ]);

    // Drive pane A via setPaneUrl (chrome-style navigation).
    act(() => {
      usePanesStore.getState().setPaneUrl("pane-a", "/cluster/prod/logs");
    });

    const after = usePanesStore.getState().panes.map((p) => p.url);
    expect(after).toEqual([
      "/cluster/prod/logs",
      "/cluster/staging/workloads",
    ]);
  });
});
