/**
 * Panes store — owns the split-view layout.
 *
 * Each pane is an independent "browser window inside Lumen": its own
 * URL, its own tab strip (held in tabsStore keyed by paneId), and its
 * own router context. The focused pane drives the URL bar and the
 * singleton `useClusterStore`; non-focused panes keep navigating
 * independently in their own MemoryRouter.
 *
 * Invariants
 *  - There is always at least one pane.
 *  - `focusedId` always points at a pane in `panes`.
 *  - `sizes` always has the same length as `panes` and sums to ~100.
 *
 * Persistence
 *  - Persisted under `lumen-panes` so splits survive reload.
 *  - On first load (no persisted state) we seed a single pane at "/".
 *    The PaneShell's location-syncer will overwrite that URL once the
 *    pane's MemoryRouter resolves to the user's actual entry point.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Pane = {
  id: string;
  /** Pathname + search representing this pane's most recent location. */
  url: string;
};

export type SplitOrientation = "horizontal" | "vertical";

type Store = {
  panes: Pane[];
  focusedId: string;
  sizes: number[];
  orientation: SplitOrientation;
  /**
   * Add a new pane by cloning the focused pane's URL. Returns the new
   * pane id. The new pane is inserted directly after the focused one
   * and becomes focused. Sizes redistribute evenly.
   */
  splitPane: () => string;
  /**
   * Close `id`. The last pane is never removed — the call becomes a
   * no-op so the user is never left without a workspace. Returns the
   * new focused id (unchanged if `id` wasn't focused).
   */
  closePane: (id: string) => string;
  focusPane: (id: string) => void;
  /** Update a pane's url. No-op if the value is unchanged. */
  setPaneUrl: (id: string, url: string) => void;
  /** Resize via splitter drag. The handler computes `sizes` directly. */
  setSizes: (sizes: number[]) => void;
  setOrientation: (orientation: SplitOrientation) => void;
  /** Cycle focus through the panes left-to-right. No-op on a single pane. */
  focusNext: () => void;
  focusPrev: () => void;
  reset: () => void;
};

const DEFAULT_URL = "/cluster";

function makeId(): string {
  return `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function evenSizes(count: number): number[] {
  if (count <= 0) return [];
  const each = 100 / count;
  return Array.from({ length: count }, () => each);
}

const initialPane: Pane = { id: makeId(), url: DEFAULT_URL };

export const usePanesStore = create<Store>()(
  persist(
    (set, get) => ({
      panes: [initialPane],
      focusedId: initialPane.id,
      sizes: [100],
      orientation: "horizontal",

      splitPane: () => {
        const { panes, focusedId } = get();
        const focused = panes.find((p) => p.id === focusedId) ?? panes[0];
        const sourceUrl = focused?.url ?? DEFAULT_URL;
        const newPane: Pane = { id: makeId(), url: sourceUrl };
        const idx = panes.findIndex((p) => p.id === focusedId);
        const insertAt = idx === -1 ? panes.length : idx + 1;
        const nextPanes = [
          ...panes.slice(0, insertAt),
          newPane,
          ...panes.slice(insertAt),
        ];
        set({
          panes: nextPanes,
          focusedId: newPane.id,
          sizes: evenSizes(nextPanes.length),
        });
        return newPane.id;
      },

      closePane: (id) => {
        const { panes, focusedId } = get();
        if (panes.length <= 1) return focusedId;
        const idx = panes.findIndex((p) => p.id === id);
        if (idx === -1) return focusedId;
        const nextPanes = panes.filter((p) => p.id !== id);
        // If we closed the focused pane, focus shifts to its right
        // neighbor (falls back to left) — matches what users expect
        // from window-manager pane semantics.
        let nextFocused = focusedId;
        if (focusedId === id) {
          const neighbor = panes[idx + 1] ?? panes[idx - 1];
          nextFocused = neighbor?.id ?? nextPanes[0].id;
        }
        set({
          panes: nextPanes,
          focusedId: nextFocused,
          sizes: evenSizes(nextPanes.length),
        });
        return nextFocused;
      },

      focusPane: (id) => {
        if (!get().panes.some((p) => p.id === id)) return;
        if (get().focusedId === id) return;
        set({ focusedId: id });
      },

      setPaneUrl: (id, url) => {
        const { panes } = get();
        const target = panes.find((p) => p.id === id);
        if (!target || target.url === url) return;
        set({
          panes: panes.map((p) => (p.id === id ? { ...p, url } : p)),
        });
      },

      setSizes: (sizes) => {
        if (sizes.length !== get().panes.length) return;
        set({ sizes });
      },

      setOrientation: (orientation) => set({ orientation }),

      focusNext: () => {
        const { panes, focusedId } = get();
        if (panes.length < 2) return;
        const idx = panes.findIndex((p) => p.id === focusedId);
        const next = panes[(idx + 1) % panes.length];
        set({ focusedId: next.id });
      },

      focusPrev: () => {
        const { panes, focusedId } = get();
        if (panes.length < 2) return;
        const idx = panes.findIndex((p) => p.id === focusedId);
        const prev = panes[(idx - 1 + panes.length) % panes.length];
        set({ focusedId: prev.id });
      },

      reset: () => {
        const fresh = { id: makeId(), url: DEFAULT_URL };
        set({
          panes: [fresh],
          focusedId: fresh.id,
          sizes: [100],
          orientation: "horizontal",
        });
      },
    }),
    { name: "lumen-panes" },
  ),
);

/** Helper for non-React contexts — read the focused pane's id. */
export function getFocusedPaneId(): string {
  return usePanesStore.getState().focusedId;
}

/** Helper for non-React contexts — read the focused pane's url. */
export function getFocusedPaneUrl(): string {
  const { panes, focusedId } = usePanesStore.getState();
  return panes.find((p) => p.id === focusedId)?.url ?? DEFAULT_URL;
}

/**
 * Chrome-level navigation helper. Updates the focused pane's URL in
 * the store; the focused pane's `PaneLocationBridge` picks the change
 * up and calls navigate() inside that pane's MemoryRouter. Use this
 * from NavBar, CommandPalette, and other components that live outside
 * any per-pane router.
 */
export function navigateFocused(url: string): void {
  const { focusedId } = usePanesStore.getState();
  usePanesStore.getState().setPaneUrl(focusedId, url);
}

/** React hook flavour — re-renders the caller when the focused pane URL changes. */
export function useFocusedPaneUrl(): string {
  return usePanesStore((s) => {
    const focused = s.panes.find((p) => p.id === s.focusedId);
    return focused?.url ?? DEFAULT_URL;
  });
}
