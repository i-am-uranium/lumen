import { beforeEach, describe, expect, it } from "vitest";
import { deriveTab, useTabsStore } from "./tabs";

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
