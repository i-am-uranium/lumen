import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { TabBar, TabsSyncer } from "./TabBar";
import { useTabsStore } from "@/state/tabs";

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{pathname + search}</div>;
}

function harness(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <TabsSyncer />
      <TabBar />
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
    // Title derivation includes the namespace hint.
    expect(await screen.findByText("prod · Workloads · payments")).toBeInTheDocument();
    const state = useTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeId).toBe(state.tabs[0].id);
  });

  it("opens a new tab via the + button and navigates to it", async () => {
    harness("/cluster/prod/workloads");
    await screen.findByText("prod · Workloads");
    await userEvent.click(screen.getByRole("button", { name: /new tab/i }));
    expect(screen.getByTestId("location").textContent).toBe("/cluster");
    expect(useTabsStore.getState().tabs).toHaveLength(2);
    expect(screen.getByText("Fleet")).toBeInTheDocument();
  });

  it("switches tabs by click, navigating to the stored URL", async () => {
    harness("/cluster/prod/workloads");
    await screen.findByText("prod · Workloads");

    // Seed a second tab via the store (simulates the user having two
    // tabs open from a previous session). Wrap in act so React flushes
    // the resulting re-render before we query the DOM.
    let secondId = "";
    act(() => {
      secondId = useTabsStore.getState().openTab("/cluster/staging/logs?ns=ops");
    });
    const secondLabel = await screen.findByText("staging · Logs · ops");
    expect(useTabsStore.getState().activeId).toBe(secondId);

    // Click the first to switch back.
    await userEvent.click(screen.getByText("prod · Workloads"));
    expect(screen.getByTestId("location").textContent).toBe("/cluster/prod/workloads");
    expect(useTabsStore.getState().activeId).not.toBe(secondId);

    // sanity: clicking the second tab still works
    await userEvent.click(secondLabel);
    expect(screen.getByTestId("location").textContent).toBe(
      "/cluster/staging/logs?ns=ops",
    );
  });

  it("closes the active tab with X and navigates to the focused neighbor", async () => {
    harness("/cluster/a/workloads");
    await screen.findByText("a · Workloads");
    act(() => {
      useTabsStore.getState().openTab("/cluster/b/workloads");
    });
    await screen.findByText("b · Workloads");
    // openTab activates "b", so closing it should navigate back to "a".
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
    // Open via the + button so the URL actually advances to fleet.
    await userEvent.click(screen.getByRole("button", { name: /new tab/i }));
    expect(await screen.findByText("Fleet")).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe("/cluster");

    // Close the inactive tab "a · Workloads" — URL should remain at fleet.
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
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });

  it("preserves the prior tab's title when a new tab is opened over it", async () => {
    harness("/cluster/prod/workloads");
    await screen.findByText("prod · Workloads");
    await userEvent.click(screen.getByRole("button", { name: /new tab/i }));
    // The newly opened tab inherits the fleet URL → "Fleet".
    expect(await screen.findByText("Fleet")).toBeInTheDocument();
    // The original "prod · Workloads" tab is still there with its preserved URL.
    expect(screen.getByText("prod · Workloads")).toBeInTheDocument();
  });
});
