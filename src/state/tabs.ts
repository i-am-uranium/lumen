/**
 * Tab strip state — one tab per "thing you have open", scoped per pane.
 *
 * A tab is a frozen URL (pathname + search). Switching tabs is just
 * navigate(url) inside the owning pane; the existing routes pull
 * cluster/namespace/etc. out of the URL so no view component needs to
 * know tabs exist.
 *
 * Each pane carries its own list of tabs. Actions take a `paneId` to
 * indicate which pane to operate on; chrome-level callers (NavBar
 * shortcuts, command palette) resolve the focused paneId from
 * `panesStore`. The store also keeps a one-time `legacyTabs` slot so
 * tabs persisted before the split-pane refactor get migrated onto the
 * first pane the app initializes — see the persist `migrate` below.
 *
 * Visible order = pinned tabs first (in store order), then unpinned.
 * Reorder operations respect that boundary — pinned tabs can only be
 * dragged within the pinned section, and the same for unpinned.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Tab = {
  id: string;
  /** Pathname + search, e.g. "/cluster/prod/workloads?ns=payments". */
  url: string;
  /** Derived from url; cached so we don't re-parse on every render. */
  title: string;
  /** Cluster context extracted from url, used for color hints. null = fleet/settings. */
  context: string | null;
  /** Pinned tabs render before unpinned and hide their close affordance. */
  pinned?: boolean;
};

export type PaneTabsState = {
  tabs: Tab[];
  activeId: string | null;
};

type Store = {
  byPane: Record<string, PaneTabsState>;

  /** Ensure pane `paneId` has a tabs entry. Seeds from `url` if empty. */
  initPane: (paneId: string, url: string) => void;
  /** Remove a pane's tabs entry. Called when the user closes a pane. */
  removePane: (paneId: string) => void;

  openTab: (paneId: string, url: string) => string;
  closeTab: (paneId: string, id: string) => string | null;
  closeOthers: (paneId: string, id: string) => string | null;
  closeToRight: (paneId: string, id: string) => void;
  duplicateTab: (paneId: string, id: string) => string | null;
  setActive: (paneId: string, id: string) => void;
  jumpToIndex: (paneId: string, n: number) => void;
  pinTab: (paneId: string, id: string) => void;
  unpinTab: (paneId: string, id: string) => void;
  reorderTab: (paneId: string, fromIndex: number, toIndex: number) => void;
  syncActiveUrl: (paneId: string, url: string) => void;
  ensureSeeded: (paneId: string, url: string) => void;
  next: (paneId: string) => void;
  prev: (paneId: string) => void;
  reset: () => void;
};

const FLEET_URL = "/cluster";

function makeId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function humanize(segment: string): string {
  if (!segment) return "";
  const decoded = decodeURIComponent(segment);
  if (decoded.toLowerCase() === "crds") return "CRDs";
  if (decoded.toLowerCase() === "rbac") return "RBAC";
  if (decoded.toLowerCase() === "argocd") return "ArgoCD";
  return decoded.charAt(0).toUpperCase() + decoded.slice(1).replace(/-/g, " ");
}

export function deriveTab(url: string): { title: string; context: string | null } {
  const [pathRaw = "", queryRaw = ""] = url.split("?");
  const params = new URLSearchParams(queryRaw);
  const parts = pathRaw.split("/").filter(Boolean);

  if (parts.length === 0) return { title: "Home", context: null };
  if (parts[0] === "settings") return { title: "Settings", context: null };
  if (parts[0] !== "cluster") {
    return { title: humanize(parts[0]) || "Home", context: null };
  }
  if (parts.length === 1) return { title: "Fleet", context: null };

  const context = decodeURIComponent(parts[1]);
  const view = parts[2] ? humanize(parts[2]) : "";
  const ns = params.get("ns");
  const base = view ? `${context} · ${view}` : context;
  return { title: ns ? `${base} · ${ns}` : base, context };
}

function normalize(url: string): string {
  if (!url) return FLEET_URL;
  if (url === "/") return FLEET_URL;
  return url.replace(/\/+$/, "");
}

function makeTab(url: string, opts: { pinned?: boolean } = {}): Tab {
  const normalized = normalize(url);
  const { title, context } = deriveTab(normalized);
  return { id: makeId(), url: normalized, title, context, pinned: opts.pinned };
}

/** Pinned tabs first (store order); unpinned after. Stable within each section. */
export function visibleOrder(tabs: Tab[]): Tab[] {
  const pinned: Tab[] = [];
  const unpinned: Tab[] = [];
  for (const t of tabs) (t.pinned ? pinned : unpinned).push(t);
  return [...pinned, ...unpinned];
}

/** Read a pane's tabs state, or return an empty default if uninitialised. */
function readPane(byPane: Record<string, PaneTabsState>, paneId: string): PaneTabsState {
  return byPane[paneId] ?? { tabs: [], activeId: null };
}

function writePane(
  byPane: Record<string, PaneTabsState>,
  paneId: string,
  state: PaneTabsState,
): Record<string, PaneTabsState> {
  return { ...byPane, [paneId]: state };
}

function repairPaneState(pane: PaneTabsState): PaneTabsState {
  if (pane.tabs.length < 2) return pane;

  const tabs: Tab[] = [];
  const indexByUrl = new Map<string, number>();
  for (const tab of pane.tabs) {
    const key = normalize(tab.url);
    const existingIndex = indexByUrl.get(key);
    if (existingIndex === undefined) {
      indexByUrl.set(key, tabs.length);
      tabs.push(tab.url === key ? tab : { ...tab, url: key });
      continue;
    }
    if (tab.id === pane.activeId) {
      tabs[existingIndex] = tab.url === key ? tab : { ...tab, url: key };
    }
  }

  const activeId = tabs.some((tab) => tab.id === pane.activeId)
    ? pane.activeId
    : tabs[0]?.id ?? null;
  if (tabs.length === pane.tabs.length && activeId === pane.activeId) return pane;
  return { tabs, activeId };
}

export const useTabsStore = create<Store>()(
  persist(
    (set, get) => ({
      byPane: {},

      initPane: (paneId, url) => {
        const { byPane } = get();
        if (byPane[paneId]) return;
        const seed = makeTab(url);
        set({
          byPane: writePane(byPane, paneId, { tabs: [seed], activeId: seed.id }),
        });
      },

      removePane: (paneId) => {
        const { byPane } = get();
        if (!byPane[paneId]) return;
        const next = { ...byPane };
        delete next[paneId];
        set({ byPane: next });
      },

      openTab: (paneId, url) => {
        const normalized = normalize(url);
        const pane = readPane(get().byPane, paneId);
        const existing = pane.tabs.find((t) => t.url === normalized);
        if (existing) {
          set({ byPane: writePane(get().byPane, paneId, { ...pane, activeId: existing.id }) });
          return existing.id;
        }
        const tab = makeTab(normalized);
        set({
          byPane: writePane(get().byPane, paneId, {
            tabs: [...pane.tabs, tab],
            activeId: tab.id,
          }),
        });
        return tab.id;
      },

      closeTab: (paneId, id) => {
        const pane = readPane(get().byPane, paneId);
        const idx = pane.tabs.findIndex((t) => t.id === id);
        if (idx === -1) return pane.activeId;

        // Last tab: leave it in place rather than churning a synthetic
        // replacement. The UI hides the close affordance for this case,
        // and this store-level guard also protects keyboard/context paths.
        if (pane.tabs.length === 1) {
          return pane.activeId;
        }

        const nextTabs = pane.tabs.filter((t) => t.id !== id);
        let nextActive = pane.activeId;
        if (pane.activeId === id) {
          const ordered = visibleOrder(pane.tabs);
          const vIdx = ordered.findIndex((t) => t.id === id);
          const neighbor = ordered[vIdx + 1] ?? ordered[vIdx - 1];
          nextActive = neighbor?.id ?? nextTabs[0]?.id ?? null;
        }
        set({
          byPane: writePane(get().byPane, paneId, {
            tabs: nextTabs,
            activeId: nextActive,
          }),
        });
        return nextActive;
      },

      closeOthers: (paneId, id) => {
        const pane = readPane(get().byPane, paneId);
        const kept = pane.tabs.filter((t) => t.id === id || t.pinned);
        if (kept.length === 0) return pane.activeId;
        const nextActive = kept.some((t) => t.id === id) ? id : kept[0].id;
        set({
          byPane: writePane(get().byPane, paneId, {
            tabs: kept,
            activeId: nextActive,
          }),
        });
        return nextActive;
      },

      closeToRight: (paneId, id) => {
        const pane = readPane(get().byPane, paneId);
        const ordered = visibleOrder(pane.tabs);
        const vIdx = ordered.findIndex((t) => t.id === id);
        if (vIdx === -1) return;
        const toClose = new Set(
          ordered.slice(vIdx + 1).filter((t) => !t.pinned).map((t) => t.id),
        );
        if (toClose.size === 0) return;
        const nextTabs = pane.tabs.filter((t) => !toClose.has(t.id));
        const nextActive =
          pane.activeId && toClose.has(pane.activeId) ? id : pane.activeId;
        set({
          byPane: writePane(get().byPane, paneId, {
            tabs: nextTabs,
            activeId: nextActive,
          }),
        });
      },

      duplicateTab: (paneId, id) => {
        const pane = readPane(get().byPane, paneId);
        const src = pane.tabs.find((t) => t.id === id);
        if (!src) return null;
        const copy = makeTab(src.url);
        const idx = pane.tabs.findIndex((t) => t.id === id);
        const next = [...pane.tabs.slice(0, idx + 1), copy, ...pane.tabs.slice(idx + 1)];
        set({
          byPane: writePane(get().byPane, paneId, {
            tabs: next,
            activeId: copy.id,
          }),
        });
        return copy.id;
      },

      setActive: (paneId, id) => {
        const pane = readPane(get().byPane, paneId);
        if (!pane.tabs.some((t) => t.id === id)) return;
        set({
          byPane: writePane(get().byPane, paneId, { ...pane, activeId: id }),
        });
      },

      jumpToIndex: (paneId, n) => {
        const pane = readPane(get().byPane, paneId);
        const ordered = visibleOrder(pane.tabs);
        const target = ordered[n];
        if (!target) return;
        set({
          byPane: writePane(get().byPane, paneId, { ...pane, activeId: target.id }),
        });
      },

      pinTab: (paneId, id) => {
        const pane = readPane(get().byPane, paneId);
        const target = pane.tabs.find((t) => t.id === id);
        if (!target || target.pinned) return;
        const updated: Tab = { ...target, pinned: true };
        const rest = pane.tabs.filter((t) => t.id !== id);
        let lastPinned = -1;
        for (let i = rest.length - 1; i >= 0; i--) {
          if (rest[i].pinned) {
            lastPinned = i;
            break;
          }
        }
        const insertAt = lastPinned + 1;
        const next = [...rest.slice(0, insertAt), updated, ...rest.slice(insertAt)];
        set({
          byPane: writePane(get().byPane, paneId, { ...pane, tabs: next }),
        });
      },

      unpinTab: (paneId, id) => {
        const pane = readPane(get().byPane, paneId);
        const target = pane.tabs.find((t) => t.id === id);
        if (!target || !target.pinned) return;
        const updated: Tab = { ...target, pinned: false };
        const rest = pane.tabs.filter((t) => t.id !== id);
        const firstUnpinned = rest.findIndex((t) => !t.pinned);
        const insertAt = firstUnpinned === -1 ? rest.length : firstUnpinned;
        const next = [...rest.slice(0, insertAt), updated, ...rest.slice(insertAt)];
        set({
          byPane: writePane(get().byPane, paneId, { ...pane, tabs: next }),
        });
      },

      reorderTab: (paneId, fromIndex, toIndex) => {
        const pane = readPane(get().byPane, paneId);
        const ordered = visibleOrder(pane.tabs);
        if (fromIndex < 0 || fromIndex >= ordered.length) return;
        if (fromIndex === toIndex) return;
        const moved = ordered[fromIndex];
        const pinnedCount = ordered.filter((t) => t.pinned).length;
        const min = moved.pinned ? 0 : pinnedCount;
        const max = moved.pinned ? pinnedCount - 1 : ordered.length - 1;
        const clamped = Math.max(min, Math.min(max, toIndex));
        if (clamped === fromIndex) return;
        const reordered = ordered.slice();
        reordered.splice(fromIndex, 1);
        reordered.splice(clamped, 0, moved);
        set({
          byPane: writePane(get().byPane, paneId, { ...pane, tabs: reordered }),
        });
      },

      syncActiveUrl: (paneId, url) => {
        const normalized = normalize(url);
        const pane = readPane(get().byPane, paneId);
        if (!pane.activeId) return;
        const active = pane.tabs.find((t) => t.id === pane.activeId);
        if (!active || active.url === normalized) return;
        const { title, context } = deriveTab(normalized);
        set({
          byPane: writePane(get().byPane, paneId, {
            ...pane,
            tabs: pane.tabs.map((t) =>
              t.id === pane.activeId ? { ...t, url: normalized, title, context } : t,
            ),
          }),
        });
      },

      ensureSeeded: (paneId, url) => {
        const pane = readPane(get().byPane, paneId);
        const repaired = repairPaneState(pane);
        if (repaired !== pane) {
          set({ byPane: writePane(get().byPane, paneId, repaired) });
          return;
        }
        if (pane.tabs.length > 0) return;
        const tab = makeTab(url);
        set({
          byPane: writePane(get().byPane, paneId, {
            tabs: [tab],
            activeId: tab.id,
          }),
        });
      },

      next: (paneId) => {
        const pane = readPane(get().byPane, paneId);
        const ordered = visibleOrder(pane.tabs);
        if (ordered.length < 2 || !pane.activeId) return;
        const idx = ordered.findIndex((t) => t.id === pane.activeId);
        if (idx === -1) return;
        set({
          byPane: writePane(get().byPane, paneId, {
            ...pane,
            activeId: ordered[(idx + 1) % ordered.length].id,
          }),
        });
      },

      prev: (paneId) => {
        const pane = readPane(get().byPane, paneId);
        const ordered = visibleOrder(pane.tabs);
        if (ordered.length < 2 || !pane.activeId) return;
        const idx = ordered.findIndex((t) => t.id === pane.activeId);
        if (idx === -1) return;
        set({
          byPane: writePane(get().byPane, paneId, {
            ...pane,
            activeId: ordered[(idx - 1 + ordered.length) % ordered.length].id,
          }),
        });
      },

      reset: () => set({ byPane: {} }),
    }),
    {
      name: "lumen-tabs",
      version: 1,
      // Bumping the version causes zustand to discard any v0 payload
      // (the pre-split-panes single-pane shape with top-level `tabs`/
      // `activeId`). That's a one-shot reset for early adopters — the
      // tabs feature only shipped one release before this rewrite.
    },
  ),
);

export const TABS_NEW_URL = FLEET_URL;

/**
 * Was this click meant to "open in a new tab"? Matches the browser
 * convention: middle-click or Cmd/Ctrl+click. Pass the original event
 * (the React synthetic wrapper works fine).
 */
export function shouldOpenInNewTab(e: {
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): boolean {
  return Boolean(e.metaKey || e.ctrlKey || e.button === 1);
}

/**
 * Open `targetUrl` in a fresh tab inside `paneId` without losing the
 * user's current view. Stashes `currentUrl` into the active tab first
 * (so the navigation doesn't overwrite it), opens the new tab, then
 * navigates the caller's router to it.
 */
export function openInNewTab(
  paneId: string,
  targetUrl: string,
  navigate: (url: string) => void,
  currentUrl?: string,
): void {
  const store = useTabsStore.getState();
  if (currentUrl) store.syncActiveUrl(paneId, currentUrl);
  store.openTab(paneId, targetUrl);
  navigate(targetUrl);
}

/** Convenience getter for a pane's tabs — returns an empty state if uninitialised. */
export function getPaneTabs(paneId: string): PaneTabsState {
  return readPane(useTabsStore.getState().byPane, paneId);
}
