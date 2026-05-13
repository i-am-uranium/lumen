import { beforeEach, describe, expect, it } from "vitest";
import { deriveTab, useTabsStore, visibleOrder } from "./tabs";

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
  it("creates a new tab and activates it", () => {
    const id = useTabsStore.getState().openTab("/cluster/prod/workloads");
    const { tabs, activeId } = useTabsStore.getState();
    expect(tabs).toHaveLength(1);
    expect(activeId).toBe(id);
    expect(tabs[0].title).toBe("prod · Workloads");
    expect(tabs[0].context).toBe("prod");
  });

  it("activates the existing tab instead of duplicating on same url", () => {
    const a = useTabsStore.getState().openTab("/cluster/prod/workloads");
    useTabsStore.getState().openTab("/cluster/staging/logs");
    const b = useTabsStore.getState().openTab("/cluster/prod/workloads");
    expect(a).toBe(b);
    expect(useTabsStore.getState().tabs).toHaveLength(2);
    expect(useTabsStore.getState().activeId).toBe(a);
  });

  it("treats trailing-slash variants as the same url", () => {
    const a = useTabsStore.getState().openTab("/cluster/prod/workloads");
    const b = useTabsStore.getState().openTab("/cluster/prod/workloads/");
    expect(a).toBe(b);
    expect(useTabsStore.getState().tabs).toHaveLength(1);
  });
});

describe("useTabsStore.closeTab", () => {
  it("shifts focus to the right neighbor when closing the active tab", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    const b = useTabsStore.getState().openTab("/cluster/b/workloads");
    const c = useTabsStore.getState().openTab("/cluster/c/workloads");
    useTabsStore.getState().setActive(b);
    useTabsStore.getState().closeTab(b);
    expect(useTabsStore.getState().activeId).toBe(c);
    expect(useTabsStore.getState().tabs.map((t) => t.id)).toEqual([a, c]);
  });

  it("falls back to the left neighbor when closing the rightmost active tab", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    const b = useTabsStore.getState().openTab("/cluster/b/workloads");
    useTabsStore.getState().setActive(b);
    useTabsStore.getState().closeTab(b);
    expect(useTabsStore.getState().activeId).toBe(a);
  });

  it("never empties the strip — closing the last tab resets it to fleet", () => {
    useTabsStore.getState().openTab("/cluster/a/workloads");
    const only = useTabsStore.getState().tabs[0].id;
    const newId = useTabsStore.getState().closeTab(only);
    const state = useTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].url).toBe("/cluster");
    expect(state.activeId).toBe(newId);
    expect(state.activeId).toBe(state.tabs[0].id);
  });
});

describe("useTabsStore.syncActiveUrl", () => {
  it("updates the active tab's url and re-derives the title", () => {
    const id = useTabsStore.getState().openTab("/cluster/prod/workloads");
    useTabsStore.getState().syncActiveUrl("/cluster/prod/logs?ns=payments");
    const tab = useTabsStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.url).toBe("/cluster/prod/logs?ns=payments");
    expect(tab.title).toBe("prod · Logs · payments");
  });

  it("is a no-op when there's no active tab", () => {
    useTabsStore.getState().syncActiveUrl("/cluster/prod/workloads");
    expect(useTabsStore.getState().tabs).toHaveLength(0);
  });
});

describe("useTabsStore.next/prev", () => {
  it("cycles forward and wraps", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    const b = useTabsStore.getState().openTab("/cluster/b/workloads");
    const c = useTabsStore.getState().openTab("/cluster/c/workloads");
    useTabsStore.getState().setActive(a);
    useTabsStore.getState().next();
    expect(useTabsStore.getState().activeId).toBe(b);
    useTabsStore.getState().next();
    expect(useTabsStore.getState().activeId).toBe(c);
    useTabsStore.getState().next();
    expect(useTabsStore.getState().activeId).toBe(a);
  });

  it("cycles backward and wraps", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    useTabsStore.getState().openTab("/cluster/b/workloads");
    const c = useTabsStore.getState().openTab("/cluster/c/workloads");
    useTabsStore.getState().setActive(a);
    useTabsStore.getState().prev();
    expect(useTabsStore.getState().activeId).toBe(c);
  });
});

describe("useTabsStore.ensureSeeded", () => {
  it("seeds a tab when the strip is empty", () => {
    useTabsStore.getState().ensureSeeded("/cluster/prod/workloads");
    const state = useTabsStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].url).toBe("/cluster/prod/workloads");
    expect(state.activeId).toBe(state.tabs[0].id);
  });

  it("is idempotent — leaves existing tabs untouched", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    useTabsStore.getState().ensureSeeded("/cluster/b/workloads");
    expect(useTabsStore.getState().tabs).toHaveLength(1);
    expect(useTabsStore.getState().activeId).toBe(a);
  });
});

describe("pin / unpin", () => {
  it("pinning moves the tab to the pinned section without changing active", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    const b = useTabsStore.getState().openTab("/cluster/b/workloads");
    const c = useTabsStore.getState().openTab("/cluster/c/workloads");
    useTabsStore.getState().setActive(b);
    useTabsStore.getState().pinTab(b);
    const ordered = visibleOrder(useTabsStore.getState().tabs);
    expect(ordered.map((t) => t.id)).toEqual([b, a, c]);
    expect(useTabsStore.getState().activeId).toBe(b);
    expect(ordered[0].pinned).toBe(true);
  });

  it("pinning a second tab appends to the pinned section in order", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    const b = useTabsStore.getState().openTab("/cluster/b/workloads");
    useTabsStore.getState().openTab("/cluster/c/workloads");
    useTabsStore.getState().pinTab(a);
    useTabsStore.getState().pinTab(b);
    expect(visibleOrder(useTabsStore.getState().tabs).map((t) => t.id)).toEqual([
      a,
      b,
      expect.any(String),
    ]);
  });

  it("unpinning moves the tab to the start of the unpinned section", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    const b = useTabsStore.getState().openTab("/cluster/b/workloads");
    const c = useTabsStore.getState().openTab("/cluster/c/workloads");
    useTabsStore.getState().pinTab(a);
    useTabsStore.getState().pinTab(b);
    useTabsStore.getState().unpinTab(a);
    expect(visibleOrder(useTabsStore.getState().tabs).map((t) => t.id)).toEqual([
      b,
      a,
      c,
    ]);
  });

  it("ignores pinning when already pinned (and vice versa)", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    useTabsStore.getState().pinTab(a);
    const snapshot = useTabsStore.getState().tabs;
    useTabsStore.getState().pinTab(a);
    expect(useTabsStore.getState().tabs).toEqual(snapshot);
    useTabsStore.getState().unpinTab(a);
    useTabsStore.getState().unpinTab(a);
    expect(useTabsStore.getState().tabs.find((t) => t.id === a)?.pinned).toBeFalsy();
  });
});

describe("reorderTab", () => {
  it("moves a tab within the unpinned section", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    const b = useTabsStore.getState().openTab("/cluster/b/workloads");
    const c = useTabsStore.getState().openTab("/cluster/c/workloads");
    useTabsStore.getState().reorderTab(0, 2);
    expect(visibleOrder(useTabsStore.getState().tabs).map((t) => t.id)).toEqual([
      b,
      c,
      a,
    ]);
  });

  it("clamps cross-section drags so the pin invariant holds", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    const b = useTabsStore.getState().openTab("/cluster/b/workloads");
    const c = useTabsStore.getState().openTab("/cluster/c/workloads");
    useTabsStore.getState().pinTab(a); // visible: [a*, b, c]
    // Try to drag unpinned "c" (index 2) all the way into pinned (index 0).
    // Should clamp to the first unpinned slot (index 1) → no change.
    useTabsStore.getState().reorderTab(2, 0);
    expect(visibleOrder(useTabsStore.getState().tabs).map((t) => t.id)).toEqual([
      a,
      c,
      b,
    ]);
  });
});

describe("closeOthers / closeToRight", () => {
  it("closeOthers keeps the anchor plus all pinned tabs", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    const b = useTabsStore.getState().openTab("/cluster/b/workloads");
    const c = useTabsStore.getState().openTab("/cluster/c/workloads");
    useTabsStore.getState().pinTab(a);
    useTabsStore.getState().closeOthers(c);
    const ids = useTabsStore.getState().tabs.map((t) => t.id).sort();
    expect(ids).toEqual([a, c].sort());
    expect(useTabsStore.getState().activeId).toBe(c);
    void b;
  });

  it("closeToRight closes unpinned tabs strictly after the anchor", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    const b = useTabsStore.getState().openTab("/cluster/b/workloads");
    const c = useTabsStore.getState().openTab("/cluster/c/workloads");
    const d = useTabsStore.getState().openTab("/cluster/d/workloads");
    useTabsStore.getState().setActive(d);
    useTabsStore.getState().closeToRight(b);
    expect(visibleOrder(useTabsStore.getState().tabs).map((t) => t.id)).toEqual([
      a,
      b,
    ]);
    // Active was closed → focus shifts to the anchor.
    expect(useTabsStore.getState().activeId).toBe(b);
    void c;
  });
});

describe("duplicateTab", () => {
  it("inserts a copy after the source and activates it", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads?ns=ops");
    useTabsStore.getState().openTab("/cluster/b/workloads");
    const copyId = useTabsStore.getState().duplicateTab(a);
    expect(copyId).toBeTruthy();
    const tabs = useTabsStore.getState().tabs;
    const aIdx = tabs.findIndex((t) => t.id === a);
    expect(tabs[aIdx + 1].id).toBe(copyId);
    expect(tabs[aIdx + 1].url).toBe("/cluster/a/workloads?ns=ops");
    expect(useTabsStore.getState().activeId).toBe(copyId);
  });
});

describe("jumpToIndex", () => {
  it("activates the tab at the given visible-order index", () => {
    const a = useTabsStore.getState().openTab("/cluster/a/workloads");
    const b = useTabsStore.getState().openTab("/cluster/b/workloads");
    const c = useTabsStore.getState().openTab("/cluster/c/workloads");
    useTabsStore.getState().pinTab(b); // visible: [b*, a, c]
    useTabsStore.getState().jumpToIndex(0);
    expect(useTabsStore.getState().activeId).toBe(b);
    useTabsStore.getState().jumpToIndex(2);
    expect(useTabsStore.getState().activeId).toBe(c);
    useTabsStore.getState().jumpToIndex(99);
    // Out-of-range jumps are no-ops; activeId stays put.
    expect(useTabsStore.getState().activeId).toBe(c);
    void a;
  });
});
