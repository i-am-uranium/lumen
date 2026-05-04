export type TabId = string;

export type Tab = {
  id: TabId;
  podName: string;
};

export type LeafPanel = {
  type: "leaf";
  id: string;
  tabs: Tab[];
  activeTab: TabId;
};

export type SplitPanel = {
  type: "split";
  direction: "h" | "v";
  a: LeafPanel;
  b: LeafPanel;
};

export type PanelTree = LeafPanel | SplitPanel;

export type PanelAction =
  | { type: "addTab"; tab: Tab; leafId?: string }
  | { type: "closeTab"; tabId: TabId }
  | { type: "setActiveTab"; tabId: TabId }
  | { type: "splitPanel"; sourceLeafId: string; direction: "h" | "v"; movingTabId?: TabId }
  | { type: "moveTab"; tabId: TabId; targetLeafId: string; targetIndex?: number }
  | { type: "unsplit"; keepLeafId: string };

export const ROOT_LEAF_ID = "root";

export function initialPanel(tab: Tab): LeafPanel {
  return { type: "leaf", id: ROOT_LEAF_ID, tabs: [tab], activeTab: tab.id };
}

/** Walk the tree and return the leaf with the given id, or null. */
export function findLeaf(tree: PanelTree, id: string): LeafPanel | null {
  if (tree.type === "leaf") return tree.id === id ? tree : null;
  return findLeaf(tree.a, id) ?? findLeaf(tree.b, id);
}

/** Find which leaf a tab id lives in. */
export function findLeafForTab(tree: PanelTree, tabId: TabId): LeafPanel | null {
  if (tree.type === "leaf") {
    return tree.tabs.some((t) => t.id === tabId) ? tree : null;
  }
  return findLeafForTab(tree.a, tabId) ?? findLeafForTab(tree.b, tabId);
}

/** Replace a leaf identified by id with a new subtree. Returns a new tree. */
export function replaceLeaf(tree: PanelTree, id: string, replacement: PanelTree): PanelTree {
  if (tree.type === "leaf") {
    return tree.id === id ? replacement : tree;
  }
  // SplitPanel — only leaf children allowed in v1.
  if (tree.a.id === id) {
    // Replacement may be a leaf or a split; in v1 we only put leaves here.
    if (replacement.type !== "leaf") return tree;
    return { ...tree, a: replacement };
  }
  if (tree.b.id === id) {
    if (replacement.type !== "leaf") return tree;
    return { ...tree, b: replacement };
  }
  return tree;
}

/** Map every leaf in the tree (in place of replaceLeaf when many leaves change). */
function mapLeaves(tree: PanelTree, fn: (l: LeafPanel) => LeafPanel): PanelTree {
  if (tree.type === "leaf") return fn(tree);
  const a = fn(tree.a);
  const b = fn(tree.b);
  if (a === tree.a && b === tree.b) return tree;
  return { ...tree, a, b };
}

/** Flat list of all leaves in the tree. */
export function allLeaves(tree: PanelTree): LeafPanel[] {
  if (tree.type === "leaf") return [tree];
  return [...allLeaves(tree.a), ...allLeaves(tree.b)];
}

/** Flat list of all tabs across the tree, sorted by tab id for stable hook ordering. */
export function allTabsSorted(tree: PanelTree): Tab[] {
  const tabs: Tab[] = [];
  for (const leaf of allLeaves(tree)) tabs.push(...leaf.tabs);
  return [...tabs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Collapse a split if either side is empty: replace with the surviving sibling. */
function collapseEmpty(tree: PanelTree): PanelTree {
  if (tree.type === "leaf") return tree;
  if (tree.a.tabs.length === 0) return tree.b;
  if (tree.b.tabs.length === 0) return tree.a;
  return tree;
}

let _newLeafCounter = 0;
function newLeafId(): string {
  _newLeafCounter += 1;
  return `leaf-${Date.now().toString(36)}-${_newLeafCounter}`;
}

function closeTabInLeaf(leaf: LeafPanel, tabId: TabId): LeafPanel {
  const idx = leaf.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return leaf;
  const tabs = leaf.tabs.filter((t) => t.id !== tabId);
  let activeTab = leaf.activeTab;
  if (tabs.length === 0) {
    activeTab = "";
  } else if (leaf.activeTab === tabId) {
    const neighborIdx = Math.min(idx, tabs.length - 1);
    activeTab = tabs[neighborIdx].id;
  }
  return { ...leaf, tabs, activeTab };
}

export function panelReducer(state: PanelTree, action: PanelAction): PanelTree {
  switch (action.type) {
    case "addTab": {
      // Default to the first leaf if no leafId given (back-compat).
      const targetLeafId = action.leafId ?? allLeaves(state)[0]?.id;
      if (!targetLeafId) return state;
      // Reject duplicates anywhere in the tree.
      if (allLeaves(state).some((l) => l.tabs.some((t) => t.id === action.tab.id))) {
        return state;
      }
      const leaf = findLeaf(state, targetLeafId);
      if (!leaf) return state;
      const updated: LeafPanel = {
        ...leaf,
        tabs: [...leaf.tabs, action.tab],
        activeTab: action.tab.id,
      };
      return replaceLeaf(state, targetLeafId, updated);
    }
    case "closeTab": {
      const owner = findLeafForTab(state, action.tabId);
      if (!owner) return state;
      const totalTabs = allLeaves(state).reduce((n, l) => n + l.tabs.length, 0);
      // Don't allow closing the only tab in the entire tree.
      if (totalTabs <= 1) return state;
      const updated = closeTabInLeaf(owner, action.tabId);
      const replaced = replaceLeaf(state, owner.id, updated);
      return collapseEmpty(replaced);
    }
    case "setActiveTab": {
      const owner = findLeafForTab(state, action.tabId);
      if (!owner) return state;
      return replaceLeaf(state, owner.id, { ...owner, activeTab: action.tabId });
    }
    case "splitPanel": {
      // No nested splits in v1: only allow splitting when state is a leaf, or
      // when state is a split AND the source leaf has > 1 tabs (we'd violate
      // the cap by splitting a side of a split). Easiest enforcement: only
      // allow split when state is currently a single leaf.
      if (state.type !== "leaf") return state;
      if (state.id !== action.sourceLeafId) return state;

      const sourceLeaf = state;
      let movingTabId = action.movingTabId;
      // If no moving tab specified, move the active tab — but only if there is
      // more than one tab (we need to keep at least one in the source).
      if (!movingTabId) {
        if (sourceLeaf.tabs.length < 2) return state;
        movingTabId = sourceLeaf.activeTab;
      }
      // Must keep at least one tab in source.
      if (sourceLeaf.tabs.length < 2) return state;
      const movingTab = sourceLeaf.tabs.find((t) => t.id === movingTabId);
      if (!movingTab) return state;

      const remaining = sourceLeaf.tabs.filter((t) => t.id !== movingTabId);
      const newSourceActive =
        sourceLeaf.activeTab === movingTabId ? remaining[0].id : sourceLeaf.activeTab;

      const newSourceLeaf: LeafPanel = {
        ...sourceLeaf,
        tabs: remaining,
        activeTab: newSourceActive,
      };
      const newSiblingLeaf: LeafPanel = {
        type: "leaf",
        id: newLeafId(),
        tabs: [movingTab],
        activeTab: movingTab.id,
      };
      return {
        type: "split",
        direction: action.direction,
        a: newSourceLeaf,
        b: newSiblingLeaf,
      };
    }
    case "moveTab": {
      const sourceLeaf = findLeafForTab(state, action.tabId);
      const targetLeaf = findLeaf(state, action.targetLeafId);
      if (!sourceLeaf || !targetLeaf) return state;
      const movingTab = sourceLeaf.tabs.find((t) => t.id === action.tabId);
      if (!movingTab) return state;
      // Same leaf reorder.
      if (sourceLeaf.id === targetLeaf.id) {
        const without = sourceLeaf.tabs.filter((t) => t.id !== action.tabId);
        const insertAt = clampIndex(action.targetIndex ?? without.length, without.length);
        const tabs = [...without.slice(0, insertAt), movingTab, ...without.slice(insertAt)];
        return replaceLeaf(state, sourceLeaf.id, {
          ...sourceLeaf,
          tabs,
          activeTab: movingTab.id,
        });
      }
      // Cross-leaf: must not empty the only remaining tab if target leaf is also empty (impossible since we always have one source tab and target has its own state).
      const remaining = sourceLeaf.tabs.filter((t) => t.id !== action.tabId);
      const newSourceActive =
        remaining.length === 0
          ? ""
          : sourceLeaf.activeTab === action.tabId
            ? remaining[Math.min(remaining.findIndex(() => true), remaining.length - 1)]?.id ?? remaining[0].id
            : sourceLeaf.activeTab;
      const newSource: LeafPanel = {
        ...sourceLeaf,
        tabs: remaining,
        activeTab: newSourceActive,
      };

      const insertAt = clampIndex(action.targetIndex ?? targetLeaf.tabs.length, targetLeaf.tabs.length);
      const newTargetTabs = [
        ...targetLeaf.tabs.slice(0, insertAt),
        movingTab,
        ...targetLeaf.tabs.slice(insertAt),
      ];
      const newTarget: LeafPanel = {
        ...targetLeaf,
        tabs: newTargetTabs,
        activeTab: movingTab.id,
      };

      // Apply both updates.
      let next: PanelTree = mapLeaves(state, (l) => {
        if (l.id === sourceLeaf.id) return newSource;
        if (l.id === targetLeaf.id) return newTarget;
        return l;
      });
      next = collapseEmpty(next);
      return next;
    }
    case "unsplit": {
      if (state.type !== "split") return state;
      const keep = state.a.id === action.keepLeafId
        ? state.a
        : state.b.id === action.keepLeafId
          ? state.b
          : null;
      if (!keep) return state;
      return keep;
    }
  }
}

function clampIndex(n: number, max: number): number {
  if (n < 0) return 0;
  if (n > max) return max;
  return n;
}
