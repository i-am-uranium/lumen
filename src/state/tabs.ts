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
};

type Store = {
  tabs: Tab[];
  activeId: string | null;
  /**
   * Open a tab for `url`. If a tab already points at the same url+search,
   * activate it instead of duplicating. Returns the resulting active tab id.
   */
  openTab: (url: string) => string;
  /**
   * Close the tab with id. If it was active, focus shifts to the right
   * neighbor (falling back to left). The last tab is never removed —
   * closing it resets it to the fleet view. Returns the new active id.
   */
  closeTab: (id: string) => string | null;
  setActive: (id: string) => void;
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

function makeTab(url: string): Tab {
  const normalized = normalize(url);
  const { title, context } = deriveTab(normalized);
  return { id: makeId(), url: normalized, title, context };
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
        const tab = makeTab(normalized);
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
        return tab.id;
      },

      closeTab: (id) => {
        const { tabs, activeId } = get();
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx === -1) return activeId;

        // Last tab: reset it to fleet rather than leaving the user
        // with an empty strip and no way back.
        if (tabs.length === 1) {
          const fresh = makeTab(FLEET_URL);
          set({ tabs: [fresh], activeId: fresh.id });
          return fresh.id;
        }

        const nextTabs = tabs.filter((t) => t.id !== id);
        let nextActive = activeId;
        if (activeId === id) {
          // Prefer the right neighbor; fall back to the left.
          const neighbor = tabs[idx + 1] ?? tabs[idx - 1];
          nextActive = neighbor?.id ?? nextTabs[0]?.id ?? null;
        }
        set({ tabs: nextTabs, activeId: nextActive });
        return nextActive;
      },

      setActive: (id) => {
        if (!get().tabs.some((t) => t.id === id)) return;
        set({ activeId: id });
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
        const { tabs, activeId } = get();
        if (tabs.length < 2 || !activeId) return;
        const idx = tabs.findIndex((t) => t.id === activeId);
        if (idx === -1) return;
        set({ activeId: tabs[(idx + 1) % tabs.length].id });
      },

      prev: () => {
        const { tabs, activeId } = get();
        if (tabs.length < 2 || !activeId) return;
        const idx = tabs.findIndex((t) => t.id === activeId);
        if (idx === -1) return;
        set({ activeId: tabs[(idx - 1 + tabs.length) % tabs.length].id });
      },

      reset: () => set({ tabs: [], activeId: null }),
    }),
    { name: "lumen-tabs" },
  ),
);

export const TABS_NEW_URL = FLEET_URL;
