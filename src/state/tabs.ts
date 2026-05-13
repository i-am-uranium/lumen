/**
 * Tab strip state — one tab per "thing you have open."
 *
 * A tab is a frozen URL (pathname + search). Switching tabs is just
 * navigate(url); the existing routes pull cluster/namespace/etc. out
 * of the URL, so no view component needs to know tabs exist.
 *
 * The active tab's url is kept in sync with router state by the
 * <TabsSyncer /> mounted in App. In-app navigation (clicking a row,
 * switching contexts) updates the active tab's url+title in place,
 * matching browser-tab semantics where a tab "follows" navigation.
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

type Store = {
  tabs: Tab[];
  activeId: string | null;
  /**
   * Open a tab for `url`. If a tab already points at the same url,
   * activate it instead of duplicating. Returns the resulting active tab id.
   * Newly opened tabs land at the end of the unpinned section.
   */
  openTab: (url: string) => string;
  /**
   * Close the tab with id. If it was active, focus shifts to the right
   * neighbor (falling back to left). The last tab is never removed —
   * closing it resets it to the fleet view. Returns the new active id.
   */
  closeTab: (id: string) => string | null;
  /** Close every tab except `id` and the pinned tabs. Returns new active id. */
  closeOthers: (id: string) => string | null;
  /** Close every unpinned tab that appears after `id` in visible order. */
  closeToRight: (id: string) => void;
  /** Duplicate `id` into a fresh tab inserted immediately after it. Activates the new tab. */
  duplicateTab: (id: string) => string | null;
  setActive: (id: string) => void;
  /** Activate the tab at visible-order index `n` (0-based). No-op if out of range. */
  jumpToIndex: (n: number) => void;
  pinTab: (id: string) => void;
  unpinTab: (id: string) => void;
  /**
   * Reorder by visible-order indices. Move is clamped to the source
   * tab's section (pinned↔pinned or unpinned↔unpinned) — cross-section
   * drags collapse to the boundary so the pin invariant holds.
   */
  reorderTab: (fromIndex: number, toIndex: number) => void;
  /** Replace the active tab's url and re-derive its title. No-op if no active tab. */
  syncActiveUrl: (url: string) => void;
  /** Ensure at least one tab exists, seeded from `url`. Idempotent. */
  ensureSeeded: (url: string) => void;
  next: () => void;
  prev: () => void;
  reset: () => void;
};

const FLEET_URL = "/cluster";

function makeId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Lowercase the path segment back to a friendly display word. */
function humanize(segment: string): string {
  if (!segment) return "";
  const decoded = decodeURIComponent(segment);
  // crd-browser → CRD browser; workloads → Workloads
  if (decoded.toLowerCase() === "crds") return "CRDs";
  if (decoded.toLowerCase() === "rbac") return "RBAC";
  if (decoded.toLowerCase() === "ai") return "AI";
  if (decoded.toLowerCase() === "argocd") return "ArgoCD";
  return decoded.charAt(0).toUpperCase() + decoded.slice(1).replace(/-/g, " ");
}

/**
 * Derive { title, context } from a Lumen URL. Pure — no router needed.
 *
 * Title rules:
 *   /                            → "Home"
 *   /cluster                     → "Fleet"
 *   /cluster/<ctx>               → "<ctx>"
 *   /cluster/<ctx>/<view>...     → "<ctx> · <view>"
 *   /settings                    → "Settings"
 * If the URL carries ?ns=foo, we append " · foo" for at-a-glance scope.
 */
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

/** Normalize a url for equality comparison (drops trailing slashes). */
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

/**
 * Sort tabs into visible order: pinned (in store order) first, then unpinned.
 * Stable — preserves the relative order within each section.
 */
export function visibleOrder(tabs: Tab[]): Tab[] {
  const pinned: Tab[] = [];
  const unpinned: Tab[] = [];
  for (const t of tabs) (t.pinned ? pinned : unpinned).push(t);
  return [...pinned, ...unpinned];
}

export const useTabsStore = create<Store>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeId: null,

      openTab: (url) => {
        const normalized = normalize(url);
        const existing = get().tabs.find((t) => t.url === normalized);
        if (existing) {
          set({ activeId: existing.id });
          return existing.id;
        }
        // New tabs land at the end of the unpinned section — pinned
        // come first by construction since unpinned are appended.
        const tab = makeTab(normalized);
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
        return tab.id;
      },

      closeTab: (id) => {
        const { tabs, activeId } = get();
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx === -1) return activeId;

        // Last tab: reset it to fleet rather than leaving the user
        // with an empty strip and no way back. The reset always drops
        // pinned state — a "fresh" fleet tab is unpinned.
        if (tabs.length === 1) {
          const fresh = makeTab(FLEET_URL);
          set({ tabs: [fresh], activeId: fresh.id });
          return fresh.id;
        }

        const nextTabs = tabs.filter((t) => t.id !== id);
        let nextActive = activeId;
        if (activeId === id) {
          // Focus moves in visible order: prefer the right neighbor in
          // the visible strip, fall back to the left. We compute this
          // against the pre-close visible order so the user lands on
          // the tab they were "looking at" next.
          const ordered = visibleOrder(tabs);
          const vIdx = ordered.findIndex((t) => t.id === id);
          const neighbor = ordered[vIdx + 1] ?? ordered[vIdx - 1];
          nextActive = neighbor?.id ?? nextTabs[0]?.id ?? null;
        }
        set({ tabs: nextTabs, activeId: nextActive });
        return nextActive;
      },

      closeOthers: (id) => {
        const { tabs } = get();
        const kept = tabs.filter((t) => t.id === id || t.pinned);
        if (kept.length === 0) return get().activeId;
        const nextActive = kept.some((t) => t.id === id) ? id : kept[0].id;
        set({ tabs: kept, activeId: nextActive });
        return nextActive;
      },

      closeToRight: (id) => {
        const { tabs, activeId } = get();
        const ordered = visibleOrder(tabs);
        const vIdx = ordered.findIndex((t) => t.id === id);
        if (vIdx === -1) return;
        // Close everything strictly after the anchor that isn't pinned.
        // Pinned tabs are always "anchored to the left" and not part
        // of "to the right" semantics regardless of where they sit.
        const toClose = new Set(
          ordered.slice(vIdx + 1).filter((t) => !t.pinned).map((t) => t.id),
        );
        if (toClose.size === 0) return;
        const nextTabs = tabs.filter((t) => !toClose.has(t.id));
        const nextActive =
          activeId && toClose.has(activeId) ? id : activeId;
        set({ tabs: nextTabs, activeId: nextActive });
      },

      duplicateTab: (id) => {
        const { tabs } = get();
        const src = tabs.find((t) => t.id === id);
        if (!src) return null;
        // The duplicate is always unpinned and lands directly after the
        // source in *store* order. Visible order then sorts pinned to
        // the left, which means duplicating a pinned tab still produces
        // an unpinned copy that appears at the start of the unpinned
        // section — close enough to the source for the user to spot it.
        const copy = makeTab(src.url);
        const idx = tabs.findIndex((t) => t.id === id);
        const next = [...tabs.slice(0, idx + 1), copy, ...tabs.slice(idx + 1)];
        set({ tabs: next, activeId: copy.id });
        return copy.id;
      },

      setActive: (id) => {
        if (!get().tabs.some((t) => t.id === id)) return;
        set({ activeId: id });
      },

      jumpToIndex: (n) => {
        const ordered = visibleOrder(get().tabs);
        const target = ordered[n];
        if (!target) return;
        set({ activeId: target.id });
      },

      pinTab: (id) => {
        const { tabs } = get();
        const target = tabs.find((t) => t.id === id);
        if (!target || target.pinned) return;
        // Move to the end of the pinned section so the user can see
        // where it landed; store order is preserved within sections.
        const updated: Tab = { ...target, pinned: true };
        const rest = tabs.filter((t) => t.id !== id);
        let lastPinned = -1;
        for (let i = rest.length - 1; i >= 0; i--) {
          if (rest[i].pinned) {
            lastPinned = i;
            break;
          }
        }
        const insertAt = lastPinned + 1;
        const next = [...rest.slice(0, insertAt), updated, ...rest.slice(insertAt)];
        set({ tabs: next });
      },

      unpinTab: (id) => {
        const { tabs } = get();
        const target = tabs.find((t) => t.id === id);
        if (!target || !target.pinned) return;
        // Move to the start of the unpinned section.
        const updated: Tab = { ...target, pinned: false };
        const rest = tabs.filter((t) => t.id !== id);
        const firstUnpinned = rest.findIndex((t) => !t.pinned);
        const insertAt = firstUnpinned === -1 ? rest.length : firstUnpinned;
        const next = [...rest.slice(0, insertAt), updated, ...rest.slice(insertAt)];
        set({ tabs: next });
      },

      reorderTab: (fromIndex, toIndex) => {
        const { tabs } = get();
        const ordered = visibleOrder(tabs);
        if (fromIndex < 0 || fromIndex >= ordered.length) return;
        if (fromIndex === toIndex) return;
        const moved = ordered[fromIndex];
        // Clamp the destination to the source tab's section so the
        // pinned/unpinned invariant survives. e.g. dragging an unpinned
        // tab into the pinned region snaps to the first unpinned slot.
        const pinnedCount = ordered.filter((t) => t.pinned).length;
        const min = moved.pinned ? 0 : pinnedCount;
        const max = moved.pinned ? pinnedCount - 1 : ordered.length - 1;
        const clamped = Math.max(min, Math.min(max, toIndex));
        if (clamped === fromIndex) return;
        const reordered = ordered.slice();
        reordered.splice(fromIndex, 1);
        reordered.splice(clamped, 0, moved);
        set({ tabs: reordered });
      },

      syncActiveUrl: (url) => {
        const normalized = normalize(url);
        const { tabs, activeId } = get();
        if (!activeId) return;
        const active = tabs.find((t) => t.id === activeId);
        if (!active || active.url === normalized) return;
        const { title, context } = deriveTab(normalized);
        set({
          tabs: tabs.map((t) =>
            t.id === activeId ? { ...t, url: normalized, title, context } : t,
          ),
        });
      },

      ensureSeeded: (url) => {
        const { tabs } = get();
        if (tabs.length > 0) return;
        const tab = makeTab(url);
        set({ tabs: [tab], activeId: tab.id });
      },

      next: () => {
        const ordered = visibleOrder(get().tabs);
        const { activeId } = get();
        if (ordered.length < 2 || !activeId) return;
        const idx = ordered.findIndex((t) => t.id === activeId);
        if (idx === -1) return;
        set({ activeId: ordered[(idx + 1) % ordered.length].id });
      },

      prev: () => {
        const ordered = visibleOrder(get().tabs);
        const { activeId } = get();
        if (ordered.length < 2 || !activeId) return;
        const idx = ordered.findIndex((t) => t.id === activeId);
        if (idx === -1) return;
        set({ activeId: ordered[(idx - 1 + ordered.length) % ordered.length].id });
      },

      reset: () => set({ tabs: [], activeId: null }),
    }),
    { name: "lumen-tabs" },
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
 * Open `targetUrl` in a fresh tab without losing the user's current
 * view. We stash `currentUrl` into the active tab first (so it doesn't
 * get overwritten by the navigation), then create the new tab and
 * navigate to it. Used by row-level "Cmd-click to open elsewhere"
 * affordances across views.
 */
export function openInNewTab(
  targetUrl: string,
  navigate: (url: string) => void,
  currentUrl?: string,
): void {
  const store = useTabsStore.getState();
  if (currentUrl) store.syncActiveUrl(currentUrl);
  store.openTab(targetUrl);
  navigate(targetUrl);
}
