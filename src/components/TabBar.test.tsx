import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { TabBar, TabsSyncer } from "./TabBar";
import { getPaneTabs, useTabsStore } from "@/state/tabs";

const PANE = "test-pane";

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{pathname + search}</div>;
}

function harness(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <TabsSyncer paneId={PANE} />
      <TabBar paneId={PANE} />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useTabsStore.getState().reset();
  if (typeof window !== "undefined") {
    window.localStorage.removeItem("lumen-tabs");
  }
});

describe("<TabBar />", () => {
  it("seeds a tab from the current URL on first paint", async () => {
    harness("/cluster/prod/workloads?ns=payments");
    expect(await screen.findByText("prod · Workloads · payments")).toBeInTheDocument();
    const pane = getPaneTabs(PANE);
    expect(pane.tabs).toHaveLength(1);
    expect(pane.activeId).toBe(pane.tabs[0].id);
  });

  it("opens a new tab via the + button and navigates to it", async () => {
    harness("/cluster/prod/workloads");
    await screen.findByText("prod · Workloads");
    await userEvent.click(screen.getByRole("button", { name: /new tab/i }));
    expect(screen.getByTestId("location").textContent).toBe("/cluster");
    expect(getPaneTabs(PANE).tabs).toHaveLength(2);
    expect(screen.getByText("Fleet")).toBeInTheDocument();
  });

  it("switches tabs by click, navigating to the stored URL", async () => {
    harness("/cluster/prod/workloads");
    await screen.findByText("prod · Workloads");

    let secondId = "";
    act(() => {
      secondId = useTabsStore
        .getState()
        .openTab(PANE, "/cluster/staging/logs?ns=ops");
    });
    const secondLabel = await screen.findByText("staging · Logs · ops");
    expect(getPaneTabs(PANE).activeId).toBe(secondId);

    await userEvent.click(screen.getByText("prod · Workloads"));
    expect(screen.getByTestId("location").textContent).toBe("/cluster/prod/workloads");
    expect(getPaneTabs(PANE).activeId).not.toBe(secondId);

    await userEvent.click(secondLabel);
    expect(screen.getByTestId("location").textContent).toBe(
      "/cluster/staging/logs?ns=ops",
    );
  });

  it("closes the active tab with X and navigates to the focused neighbor", async () => {
    harness("/cluster/a/workloads");
    await screen.findByText("a · Workloads");
    act(() => {
      useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    });
    await screen.findByText("b · Workloads");
    const activeTab = screen.getByText("b · Workloads").closest("[role='tab']")!;
    const closeBtn = within(activeTab as HTMLElement).getByRole("button", {
      name: /close tab/i,
    });
    await userEvent.click(closeBtn);

    expect(screen.queryByText("b · Workloads")).not.toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe("/cluster/a/workloads");
  });

  it("closing a non-active tab leaves the active tab's URL in place", async () => {
    harness("/cluster/a/workloads");
    await screen.findByText("a · Workloads");
    await userEvent.click(screen.getByRole("button", { name: /new tab/i }));
    expect(await screen.findByText("Fleet")).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe("/cluster");

    const inactiveTab = screen.getByText("a · Workloads").closest("[role='tab']")!;
    const closeBtn = within(inactiveTab as HTMLElement).getByRole("button", {
      name: /close tab/i,
    });
    await userEvent.click(closeBtn);

    expect(screen.queryByText("a · Workloads")).not.toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe("/cluster");
  });

  it("resets to fleet when the last tab is closed instead of going empty", async () => {
    harness("/cluster/prod/workloads");
    await screen.findByText("prod · Workloads");

    const only = screen.getByText("prod · Workloads").closest("[role='tab']")!;
    const closeBtn = within(only as HTMLElement).getByRole("button", {
      name: /close tab/i,
    });
    await userEvent.click(closeBtn);

    expect(screen.getByText("Fleet")).toBeInTheDocument();
    expect(getPaneTabs(PANE).tabs).toHaveLength(1);
  });

  it("preserves the prior tab's title when a new tab is opened over it", async () => {
    harness("/cluster/prod/workloads");
    await screen.findByText("prod · Workloads");
    await userEvent.click(screen.getByRole("button", { name: /new tab/i }));
    expect(await screen.findByText("Fleet")).toBeInTheDocument();
    expect(screen.getByText("prod · Workloads")).toBeInTheDocument();
  });

  it("hides the close X on pinned tabs but still allows close via context menu", async () => {
    harness("/cluster/prod/workloads");
    const tabLabel = await screen.findByText("prod · Workloads");
    const tab = tabLabel.closest("[role='tab']") as HTMLElement;
    act(() => {
      const pane = getPaneTabs(PANE);
      useTabsStore.getState().pinTab(PANE, pane.tabs[0].id);
    });
    expect(
      within(tab).queryByRole("button", { name: /close tab/i }),
    ).not.toBeInTheDocument();

    await userEvent.pointer({
      target: tab,
      keys: "[MouseRight]",
    });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Unpin")).toBeInTheDocument();
    expect(within(menu).getByText("Close")).toBeInTheDocument();
  });

  it("right-click menu duplicates the tab and activates the copy", async () => {
    harness("/cluster/prod/workloads?ns=ops");
    const tabLabel = await screen.findByText("prod · Workloads · ops");
    const tab = tabLabel.closest("[role='tab']") as HTMLElement;
    await userEvent.pointer({ target: tab, keys: "[MouseRight]" });
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByText("Duplicate"));
    const matches = screen.getAllByText("prod · Workloads · ops");
    expect(matches.length).toBe(2);
    expect(getPaneTabs(PANE).tabs).toHaveLength(2);
  });

  it("pinning via context menu reorders the tab to the leftmost slot", async () => {
    harness("/cluster/a/workloads");
    await screen.findByText("a · Workloads");
    act(() => {
      useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    });
    await screen.findByText("b · Workloads");

    const bTab = screen.getByText("b · Workloads").closest("[role='tab']") as HTMLElement;
    await userEvent.pointer({ target: bTab, keys: "[MouseRight]" });
    const menu = await screen.findByRole("menu");
    await userEvent.click(within(menu).getByText("Pin"));

    const tabs = screen.getAllByRole("tab");
    expect(within(tabs[0]).getByText("b · Workloads")).toBeInTheDocument();
    expect(within(tabs[1]).getByText("a · Workloads")).toBeInTheDocument();
  });
});
