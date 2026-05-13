import { beforeEach, describe, expect, it } from "vitest";
import { deriveTab, getPaneTabs, useTabsStore, visibleOrder } from "./tabs";

const PANE = "test-pane";

beforeEach(() => {
  useTabsStore.getState().reset();
  if (typeof window !== "undefined") {
    window.localStorage.removeItem("lumen-tabs");
  }
});

describe("deriveTab", () => {
  it("labels the fleet view without a context", () => {
    expect(deriveTab("/cluster")).toEqual({ title: "Fleet", context: null });
  });

  it("uses the context name as the title when no view is present", () => {
    expect(deriveTab("/cluster/prod-eu")).toEqual({
      title: "prod-eu",
      context: "prod-eu",
    });
  });

  it("composes 'ctx · view' for a cluster sub-route", () => {
    expect(deriveTab("/cluster/prod/workloads")).toEqual({
      title: "prod · Workloads",
      context: "prod",
    });
  });

  it("appends the namespace scope when ?ns= is set", () => {
    expect(deriveTab("/cluster/prod/workloads?ns=payments").title).toBe(
      "prod · Workloads · payments",
    );
  });

  it("decodes percent-encoded contexts", () => {
    expect(deriveTab("/cluster/staging%2Fus-east/logs").context).toBe(
      "staging/us-east",
    );
  });

  it("normalizes lumen-specific acronyms (CRDs, AI, ArgoCD)", () => {
    expect(deriveTab("/cluster/dev/crds").title).toBe("dev · CRDs");
    expect(deriveTab("/cluster/dev/ai").title).toBe("dev · AI");
    expect(deriveTab("/cluster/dev/argocd").title).toBe("dev · ArgoCD");
  });

  it("labels the settings route", () => {
    expect(deriveTab("/settings")).toEqual({ title: "Settings", context: null });
  });
});

describe("useTabsStore.openTab", () => {
  it("creates a new tab in the given pane and activates it", () => {
    const id = useTabsStore.getState().openTab(PANE, "/cluster/prod/workloads");
    const pane = getPaneTabs(PANE);
    expect(pane.tabs).toHaveLength(1);
    expect(pane.activeId).toBe(id);
    expect(pane.tabs[0].title).toBe("prod · Workloads");
    expect(pane.tabs[0].context).toBe("prod");
  });

  it("activates the existing tab instead of duplicating on same url", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/prod/workloads");
    useTabsStore.getState().openTab(PANE, "/cluster/staging/logs");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/prod/workloads");
    expect(a).toBe(b);
    expect(getPaneTabs(PANE).tabs).toHaveLength(2);
    expect(getPaneTabs(PANE).activeId).toBe(a);
  });

  it("treats trailing-slash variants as the same url", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/prod/workloads");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/prod/workloads/");
    expect(a).toBe(b);
    expect(getPaneTabs(PANE).tabs).toHaveLength(1);
  });

  it("keeps tab lists isolated between panes", () => {
    useTabsStore.getState().openTab("pane-a", "/cluster/a");
    useTabsStore.getState().openTab("pane-b", "/cluster/b");
    expect(getPaneTabs("pane-a").tabs).toHaveLength(1);
    expect(getPaneTabs("pane-b").tabs).toHaveLength(1);
    expect(getPaneTabs("pane-a").tabs[0].url).toBe("/cluster/a");
    expect(getPaneTabs("pane-b").tabs[0].url).toBe("/cluster/b");
  });
});

describe("useTabsStore.closeTab", () => {
  it("shifts focus to the right neighbor when closing the active tab", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    const c = useTabsStore.getState().openTab(PANE, "/cluster/c/workloads");
    useTabsStore.getState().setActive(PANE, b);
    useTabsStore.getState().closeTab(PANE, b);
    expect(getPaneTabs(PANE).activeId).toBe(c);
    expect(getPaneTabs(PANE).tabs.map((t) => t.id)).toEqual([a, c]);
  });

  it("falls back to the left neighbor when closing the rightmost active tab", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    useTabsStore.getState().setActive(PANE, b);
    useTabsStore.getState().closeTab(PANE, b);
    expect(getPaneTabs(PANE).activeId).toBe(a);
  });

  it("does not close the last tab", () => {
    useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    const only = getPaneTabs(PANE).tabs[0].id;
    const nextId = useTabsStore.getState().closeTab(PANE, only);
    const pane = getPaneTabs(PANE);
    expect(pane.tabs).toHaveLength(1);
    expect(pane.tabs[0].id).toBe(only);
    expect(pane.tabs[0].url).toBe("/cluster/a/workloads");
    expect(nextId).toBe(only);
    expect(pane.activeId).toBe(pane.tabs[0].id);
  });

  it("does not replace the tab when the only tab is already fleet", () => {
    useTabsStore.getState().openTab(PANE, "/cluster");
    const only = getPaneTabs(PANE).tabs[0].id;
    const nextId = useTabsStore.getState().closeTab(PANE, only);
    const pane = getPaneTabs(PANE);
    expect(nextId).toBe(only);
    expect(pane.tabs).toHaveLength(1);
    expect(pane.tabs[0].id).toBe(only);
    expect(pane.tabs[0].url).toBe("/cluster");
    expect(pane.activeId).toBe(only);
  });
});

describe("useTabsStore.syncActiveUrl", () => {
  it("updates the active tab's url and re-derives the title", () => {
    const id = useTabsStore.getState().openTab(PANE, "/cluster/prod/workloads");
    useTabsStore.getState().syncActiveUrl(PANE, "/cluster/prod/logs?ns=payments");
    const tab = getPaneTabs(PANE).tabs.find((t) => t.id === id)!;
    expect(tab.url).toBe("/cluster/prod/logs?ns=payments");
    expect(tab.title).toBe("prod · Logs · payments");
  });

  it("is a no-op when the pane has no active tab", () => {
    useTabsStore.getState().syncActiveUrl(PANE, "/cluster/prod/workloads");
    expect(getPaneTabs(PANE).tabs).toHaveLength(0);
  });
});

describe("useTabsStore.next/prev", () => {
  it("cycles forward and wraps", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    const c = useTabsStore.getState().openTab(PANE, "/cluster/c/workloads");
    useTabsStore.getState().setActive(PANE, a);
    useTabsStore.getState().next(PANE);
    expect(getPaneTabs(PANE).activeId).toBe(b);
    useTabsStore.getState().next(PANE);
    expect(getPaneTabs(PANE).activeId).toBe(c);
    useTabsStore.getState().next(PANE);
    expect(getPaneTabs(PANE).activeId).toBe(a);
  });

  it("cycles backward and wraps", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    const c = useTabsStore.getState().openTab(PANE, "/cluster/c/workloads");
    useTabsStore.getState().setActive(PANE, a);
    useTabsStore.getState().prev(PANE);
    expect(getPaneTabs(PANE).activeId).toBe(c);
  });
});

describe("useTabsStore.ensureSeeded", () => {
  it("seeds a tab when the pane is empty", () => {
    useTabsStore.getState().ensureSeeded(PANE, "/cluster/prod/workloads");
    const pane = getPaneTabs(PANE);
    expect(pane.tabs).toHaveLength(1);
    expect(pane.tabs[0].url).toBe("/cluster/prod/workloads");
    expect(pane.activeId).toBe(pane.tabs[0].id);
  });

  it("is idempotent — leaves existing tabs untouched", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    useTabsStore.getState().ensureSeeded(PANE, "/cluster/b/workloads");
    expect(getPaneTabs(PANE).tabs).toHaveLength(1);
    expect(getPaneTabs(PANE).activeId).toBe(a);
  });

  it("repairs duplicate persisted tabs for the same url", () => {
    useTabsStore.setState({
      byPane: {
        [PANE]: {
          activeId: "dup-2",
          tabs: [
            {
              id: "dup-1",
              url: "/cluster/prod/workloads",
              title: "prod · Workloads",
              context: "prod",
            },
            {
              id: "dup-2",
              url: "/cluster/prod/workloads",
              title: "prod · Workloads",
              context: "prod",
            },
          ],
        },
      },
    });

    useTabsStore.getState().ensureSeeded(PANE, "/cluster/prod/workloads");

    const pane = getPaneTabs(PANE);
    expect(pane.tabs).toHaveLength(1);
    expect(pane.tabs[0].url).toBe("/cluster/prod/workloads");
    expect(pane.activeId).toBe(pane.tabs[0].id);
  });
});

describe("initPane / removePane", () => {
  it("initPane seeds a tab from the given url", () => {
    useTabsStore.getState().initPane(PANE, "/cluster/prod/workloads");
    expect(getPaneTabs(PANE).tabs).toHaveLength(1);
    expect(getPaneTabs(PANE).tabs[0].url).toBe("/cluster/prod/workloads");
  });

  it("initPane is idempotent — doesn't reseed an already-initialised pane", () => {
    useTabsStore.getState().initPane(PANE, "/cluster/a");
    useTabsStore.getState().initPane(PANE, "/cluster/b");
    expect(getPaneTabs(PANE).tabs).toHaveLength(1);
    expect(getPaneTabs(PANE).tabs[0].url).toBe("/cluster/a");
  });

  it("removePane drops a pane's tabs entry", () => {
    useTabsStore.getState().openTab(PANE, "/cluster/prod/workloads");
    useTabsStore.getState().removePane(PANE);
    expect(getPaneTabs(PANE).tabs).toHaveLength(0);
  });
});

describe("pin / unpin", () => {
  it("pinning moves the tab to the pinned section without changing active", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    const c = useTabsStore.getState().openTab(PANE, "/cluster/c/workloads");
    useTabsStore.getState().setActive(PANE, b);
    useTabsStore.getState().pinTab(PANE, b);
    const ordered = visibleOrder(getPaneTabs(PANE).tabs);
    expect(ordered.map((t) => t.id)).toEqual([b, a, c]);
    expect(getPaneTabs(PANE).activeId).toBe(b);
    expect(ordered[0].pinned).toBe(true);
  });

  it("pinning a second tab appends to the pinned section in order", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    useTabsStore.getState().openTab(PANE, "/cluster/c/workloads");
    useTabsStore.getState().pinTab(PANE, a);
    useTabsStore.getState().pinTab(PANE, b);
    expect(visibleOrder(getPaneTabs(PANE).tabs).map((t) => t.id)).toEqual([
      a,
      b,
      expect.any(String),
    ]);
  });

  it("unpinning moves the tab to the start of the unpinned section", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    const c = useTabsStore.getState().openTab(PANE, "/cluster/c/workloads");
    useTabsStore.getState().pinTab(PANE, a);
    useTabsStore.getState().pinTab(PANE, b);
    useTabsStore.getState().unpinTab(PANE, a);
    expect(visibleOrder(getPaneTabs(PANE).tabs).map((t) => t.id)).toEqual([
      b,
      a,
      c,
    ]);
  });

  it("ignores pinning when already pinned (and vice versa)", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    useTabsStore.getState().pinTab(PANE, a);
    const snapshot = getPaneTabs(PANE).tabs;
    useTabsStore.getState().pinTab(PANE, a);
    expect(getPaneTabs(PANE).tabs).toEqual(snapshot);
    useTabsStore.getState().unpinTab(PANE, a);
    useTabsStore.getState().unpinTab(PANE, a);
    expect(getPaneTabs(PANE).tabs.find((t) => t.id === a)?.pinned).toBeFalsy();
  });
});

describe("reorderTab", () => {
  it("moves a tab within the unpinned section", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    const c = useTabsStore.getState().openTab(PANE, "/cluster/c/workloads");
    useTabsStore.getState().reorderTab(PANE, 0, 2);
    expect(visibleOrder(getPaneTabs(PANE).tabs).map((t) => t.id)).toEqual([
      b,
      c,
      a,
    ]);
  });

  it("clamps cross-section drags so the pin invariant holds", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    const c = useTabsStore.getState().openTab(PANE, "/cluster/c/workloads");
    useTabsStore.getState().pinTab(PANE, a); // visible: [a*, b, c]
    useTabsStore.getState().reorderTab(PANE, 2, 0);
    expect(visibleOrder(getPaneTabs(PANE).tabs).map((t) => t.id)).toEqual([
      a,
      c,
      b,
    ]);
  });
});

describe("closeOthers / closeToRight", () => {
  it("closeOthers keeps the anchor plus all pinned tabs", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    const c = useTabsStore.getState().openTab(PANE, "/cluster/c/workloads");
    useTabsStore.getState().pinTab(PANE, a);
    useTabsStore.getState().closeOthers(PANE, c);
    const ids = getPaneTabs(PANE).tabs.map((t) => t.id).sort();
    expect(ids).toEqual([a, c].sort());
    expect(getPaneTabs(PANE).activeId).toBe(c);
    void b;
  });

  it("closeToRight closes unpinned tabs strictly after the anchor", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    const c = useTabsStore.getState().openTab(PANE, "/cluster/c/workloads");
    const d = useTabsStore.getState().openTab(PANE, "/cluster/d/workloads");
    useTabsStore.getState().setActive(PANE, d);
    useTabsStore.getState().closeToRight(PANE, b);
    expect(visibleOrder(getPaneTabs(PANE).tabs).map((t) => t.id)).toEqual([
      a,
      b,
    ]);
    expect(getPaneTabs(PANE).activeId).toBe(b);
    void c;
  });
});

describe("duplicateTab", () => {
  it("inserts a copy after the source and activates it", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads?ns=ops");
    useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    const copyId = useTabsStore.getState().duplicateTab(PANE, a);
    expect(copyId).toBeTruthy();
    const tabs = getPaneTabs(PANE).tabs;
    const aIdx = tabs.findIndex((t) => t.id === a);
    expect(tabs[aIdx + 1].id).toBe(copyId);
    expect(tabs[aIdx + 1].url).toBe("/cluster/a/workloads?ns=ops");
    expect(getPaneTabs(PANE).activeId).toBe(copyId);
  });
});

describe("jumpToIndex", () => {
  it("activates the tab at the given visible-order index", () => {
    const a = useTabsStore.getState().openTab(PANE, "/cluster/a/workloads");
    const b = useTabsStore.getState().openTab(PANE, "/cluster/b/workloads");
    const c = useTabsStore.getState().openTab(PANE, "/cluster/c/workloads");
    useTabsStore.getState().pinTab(PANE, b); // visible: [b*, a, c]
    useTabsStore.getState().jumpToIndex(PANE, 0);
    expect(getPaneTabs(PANE).activeId).toBe(b);
    useTabsStore.getState().jumpToIndex(PANE, 2);
    expect(getPaneTabs(PANE).activeId).toBe(c);
    useTabsStore.getState().jumpToIndex(PANE, 99);
    expect(getPaneTabs(PANE).activeId).toBe(c);
    void a;
  });
});
