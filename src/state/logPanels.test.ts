import { describe, it, expect } from "vitest";
import {
  panelReducer,
  initialPanel,
  ROOT_LEAF_ID,
  findLeaf,
  findLeafForTab,
  allLeaves,
  allTabsSorted,
  isAggregateTab,
  tabLabel,
  type PanelTree,
  type LeafPanel,
  type SplitPanel,
  type AggregateTab,
} from "./logPanels";

function tab(id: string) {
  return { id, podName: id };
}

describe("panelReducer (leaf only)", () => {
  it("addTab appends and activates", () => {
    const s0 = initialPanel(tab("t1"));
    const s1 = panelReducer(s0, { type: "addTab", tab: tab("t2") }) as LeafPanel;
    expect(s1.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(s1.activeTab).toBe("t2");
  });

  it("closeTab removes and selects neighbor", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    s = panelReducer(s, { type: "addTab", tab: tab("t3") });
    s = panelReducer(s, { type: "closeTab", tabId: "t2" });
    expect((s as LeafPanel).tabs.map((t) => t.id)).toEqual(["t1", "t3"]);
    s = panelReducer(s, { type: "closeTab", tabId: "t3" });
    expect((s as LeafPanel).tabs.map((t) => t.id)).toEqual(["t1"]);
    expect((s as LeafPanel).activeTab).toBe("t1");
  });

  it("closing the last tab is a no-op", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "closeTab", tabId: "t1" });
    expect((s as LeafPanel).tabs).toHaveLength(1);
  });

  it("setActiveTab switches", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    s = panelReducer(s, { type: "setActiveTab", tabId: "t1" });
    expect((s as LeafPanel).activeTab).toBe("t1");
  });

  it("replaceTab can replace the only placeholder tab", () => {
    let s: PanelTree = initialPanel({ id: "tab-deploy-api", podName: "api" });
    s = panelReducer(s, {
      type: "replaceTab",
      tabId: "tab-deploy-api",
      tab: { id: "tab-api-7f9d", podName: "api-7f9d" },
    });

    expect((s as LeafPanel).tabs).toEqual([
      { id: "tab-api-7f9d", podName: "api-7f9d" },
    ]);
    expect((s as LeafPanel).activeTab).toBe("tab-api-7f9d");
  });

  it("initial leaf has stable id", () => {
    const s0 = initialPanel(tab("t1"));
    expect(s0.id).toBe(ROOT_LEAF_ID);
  });
});

describe("panelReducer (split)", () => {
  it("splitPanel with movingTabId moves the tab to new sibling leaf", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    s = panelReducer(s, {
      type: "splitPanel",
      sourceLeafId: ROOT_LEAF_ID,
      direction: "h",
      movingTabId: "t2",
    });
    expect(s.type).toBe("split");
    const sp = s as SplitPanel;
    expect(sp.direction).toBe("h");
    expect(sp.a.id).toBe(ROOT_LEAF_ID);
    expect(sp.a.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(sp.b.tabs.map((t) => t.id)).toEqual(["t2"]);
    expect(sp.b.activeTab).toBe("t2");
  });

  it("splitPanel without movingTabId moves the active tab", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    // active is now t2
    s = panelReducer(s, {
      type: "splitPanel",
      sourceLeafId: ROOT_LEAF_ID,
      direction: "v",
    });
    const sp = s as SplitPanel;
    expect(sp.a.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(sp.b.tabs.map((t) => t.id)).toEqual(["t2"]);
  });

  it("splitPanel is a no-op when source has only one tab", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, {
      type: "splitPanel",
      sourceLeafId: ROOT_LEAF_ID,
      direction: "h",
      movingTabId: "t1",
    });
    expect(s.type).toBe("leaf");
  });

  it("splitPanel is a no-op when tree is already split (no nesting in v1)", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    s = panelReducer(s, {
      type: "splitPanel",
      sourceLeafId: ROOT_LEAF_ID,
      direction: "h",
      movingTabId: "t2",
    });
    const before = s;
    s = panelReducer(s, {
      type: "splitPanel",
      sourceLeafId: (before as SplitPanel).a.id,
      direction: "h",
    });
    expect(s).toBe(before);
  });

  it("moveTab between leaves", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    s = panelReducer(s, { type: "addTab", tab: tab("t3") });
    s = panelReducer(s, {
      type: "splitPanel",
      sourceLeafId: ROOT_LEAF_ID,
      direction: "h",
      movingTabId: "t3",
    });
    const sp = s as SplitPanel;
    const targetId = sp.b.id;
    s = panelReducer(s, { type: "moveTab", tabId: "t2", targetLeafId: targetId });
    const sp2 = s as SplitPanel;
    expect(sp2.a.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(sp2.b.tabs.map((t) => t.id)).toEqual(["t3", "t2"]);
    expect(sp2.b.activeTab).toBe("t2");
  });

  it("moveTab emptying source collapses the split", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    s = panelReducer(s, {
      type: "splitPanel",
      sourceLeafId: ROOT_LEAF_ID,
      direction: "h",
      movingTabId: "t2",
    });
    const sp = s as SplitPanel;
    const aId = sp.a.id;
    const bId = sp.b.id;
    // Move t1 (only tab in a) into b — a empties and split collapses.
    s = panelReducer(s, { type: "moveTab", tabId: "t1", targetLeafId: bId });
    expect(s.type).toBe("leaf");
    expect((s as LeafPanel).id).toBe(bId);
    expect((s as LeafPanel).tabs.map((t) => t.id)).toEqual(["t2", "t1"]);
    // a is gone.
    expect(findLeaf(s, aId)).toBeNull();
  });

  it("moveTab within same leaf reorders", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    s = panelReducer(s, { type: "addTab", tab: tab("t3") });
    // tabs: t1 t2 t3, active t3
    s = panelReducer(s, { type: "moveTab", tabId: "t1", targetLeafId: ROOT_LEAF_ID, targetIndex: 1 });
    const leaf = s as LeafPanel;
    expect(leaf.tabs.map((t) => t.id)).toEqual(["t2", "t1", "t3"]);
  });

  it("unsplit collapses to keep side", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    s = panelReducer(s, {
      type: "splitPanel",
      sourceLeafId: ROOT_LEAF_ID,
      direction: "h",
      movingTabId: "t2",
    });
    const sp = s as SplitPanel;
    const keepId = sp.b.id;
    s = panelReducer(s, { type: "unsplit", keepLeafId: keepId });
    expect(s.type).toBe("leaf");
    expect((s as LeafPanel).id).toBe(keepId);
    expect((s as LeafPanel).tabs.map((t) => t.id)).toEqual(["t2"]);
  });

  it("addTab respects leafId after split", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    s = panelReducer(s, {
      type: "splitPanel",
      sourceLeafId: ROOT_LEAF_ID,
      direction: "h",
      movingTabId: "t2",
    });
    const sp = s as SplitPanel;
    const bId = sp.b.id;
    s = panelReducer(s, { type: "addTab", tab: tab("t3"), leafId: bId });
    const sp2 = s as SplitPanel;
    expect(sp2.b.tabs.map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(sp2.b.activeTab).toBe("t3");
    expect(sp2.a.tabs.map((t) => t.id)).toEqual(["t1"]);
  });

  it("closeTab in split collapses when leaf empties", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    s = panelReducer(s, {
      type: "splitPanel",
      sourceLeafId: ROOT_LEAF_ID,
      direction: "h",
      movingTabId: "t2",
    });
    s = panelReducer(s, { type: "closeTab", tabId: "t2" });
    expect(s.type).toBe("leaf");
    expect((s as LeafPanel).tabs.map((t) => t.id)).toEqual(["t1"]);
  });

  it("findLeafForTab and allTabsSorted helpers", () => {
    let s: PanelTree = initialPanel(tab("t3"));
    s = panelReducer(s, { type: "addTab", tab: tab("t1") });
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    s = panelReducer(s, {
      type: "splitPanel",
      sourceLeafId: ROOT_LEAF_ID,
      direction: "h",
      movingTabId: "t1",
    });
    expect(allLeaves(s)).toHaveLength(2);
    expect(allTabsSorted(s).map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(findLeafForTab(s, "t1")?.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(findLeafForTab(s, "t2")?.tabs.map((t) => t.id).sort()).toEqual(["t2", "t3"]);
  });
});

describe("aggregate tab support", () => {
  function aggTab(id: string, pods: string[], title?: string): AggregateTab {
    return { id, kind: "aggregate", title: title ?? `${pods.length} pods`, pods };
  }

  it("isAggregateTab discriminates by kind", () => {
    expect(isAggregateTab({ id: "t1", podName: "api-1" })).toBe(false);
    expect(isAggregateTab({ id: "t1", kind: "single", podName: "api-1" })).toBe(false);
    expect(isAggregateTab(aggTab("agg-1", ["a", "b"]))).toBe(true);
  });

  it("tabLabel returns podName for single tabs and title for aggregates", () => {
    expect(tabLabel({ id: "t1", podName: "api-7f9d" })).toBe("api-7f9d");
    expect(tabLabel(aggTab("agg-1", ["a", "b", "c"], "api fleet"))).toBe("api fleet");
  });

  it("addTab accepts aggregate tabs alongside single tabs", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: aggTab("agg-1", ["a", "b"], "two pods") });
    const leaf = s as LeafPanel;
    expect(leaf.tabs).toHaveLength(2);
    expect(leaf.activeTab).toBe("agg-1");
    const agg = leaf.tabs[1];
    expect(isAggregateTab(agg)).toBe(true);
    if (isAggregateTab(agg)) {
      expect(agg.pods).toEqual(["a", "b"]);
      expect(agg.title).toBe("two pods");
    }
  });

  it("addTab dedupes aggregate tabs by id", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: aggTab("agg-1", ["a", "b"]) });
    s = panelReducer(s, { type: "addTab", tab: aggTab("agg-1", ["c", "d"]) });
    const leaf = s as LeafPanel;
    expect(leaf.tabs).toHaveLength(2);
    // Second add was ignored — still the original ["a","b"] aggregate.
    const agg = leaf.tabs[1];
    if (isAggregateTab(agg)) expect(agg.pods).toEqual(["a", "b"]);
    else throw new Error("expected aggregate tab");
  });

  it("closeTab removes an aggregate tab and selects neighbor", () => {
    let s: PanelTree = initialPanel(tab("t1"));
    s = panelReducer(s, { type: "addTab", tab: aggTab("agg-1", ["a", "b"]) });
    s = panelReducer(s, { type: "addTab", tab: tab("t2") });
    s = panelReducer(s, { type: "closeTab", tabId: "agg-1" });
    const leaf = s as LeafPanel;
    expect(leaf.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(leaf.activeTab).toBe("t2");
  });

  it("a single-pod tab and an aggregate containing the same pod can coexist", () => {
    // The "+" menu for solo pods excludes pods already open as singles, but
    // aggregates may include a pod that has its own solo tab. The reducer
    // must permit both because their tab ids are distinct.
    let s: PanelTree = initialPanel({ id: "tab-api-1", podName: "api-1" });
    s = panelReducer(s, {
      type: "addTab",
      tab: aggTab("agg-1", ["api-1", "api-2"], "api fleet"),
    });
    const leaf = s as LeafPanel;
    expect(leaf.tabs).toHaveLength(2);
    expect(leaf.tabs[0].id).toBe("tab-api-1");
    expect(leaf.tabs[1].id).toBe("agg-1");
  });
});
