import { describe, it, expect } from "vitest";
import {
  panelReducer,
  initialPanel,
  ROOT_LEAF_ID,
  findLeaf,
  findLeafForTab,
  allLeaves,
  allTabsSorted,
  type PanelTree,
  type LeafPanel,
  type SplitPanel,
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
