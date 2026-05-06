import { create } from "zustand";

// Re-exported as a stable string so the consuming components don't import a
// magic literal — same pattern as THEME_STORAGE_KEY.
export const UI_SETTINGS_STORAGE_KEY = "lumen:ui-settings";

/**
 * Persisted UI preferences
 * ────────────────────────
 *
 * Distinct from `useUi` (transient UI state like palette-open) so the
 * persistence boundary is explicit. Owns:
 *
 *   • `readOnly`     — hides every destructive action across the app:
 *                      delete / scale / restart / cordon / drain /
 *                      image-swap. The toggle lives in the topbar (and
 *                      command palette) so demo clusters or shared shells
 *                      stay safe.
 *
 *   • `hiddenColumns` — per-view column visibility for tabular routes
 *                      (workloads-pod, workloads-other, nodes). Stored
 *                      as a hidden-set rather than visible-set so adding
 *                      a new column doesn't silently disappear for
 *                      existing users (default = visible).
 *
 *   • `columnOrder`  — per-view ordered list of column keys (D10
 *                      finish). Missing keys fall back to the
 *                      descriptor's default position so introducing a
 *                      new column doesn't disappear for existing users.
 *                      `alwaysOn` columns (currently `name`) are always
 *                      pinned to the front by the consuming view —
 *                      reorder operations on them are no-ops.
 *
 *   • `shortcuts`     — user-overridable keybindings for the global
 *                      shortcut registry. Map of action-id → key chord.
 *                      Empty by default; defaults live in the registry.
 *
 *   • `argocdResourceView` — how the ArgoCD Application detail panel
 *                      renders managed resources: a flat alphabetical
 *                      list ("list") or kind-grouped collapsible
 *                      sections ("tree"). Defaults to "tree" — closer
 *                      to ArgoCD's native topology view, which is the
 *                      thing users still leave Lumen for.
 */

export type ColumnView = "workloads-pod" | "workloads-other" | "nodes";

export type ArgocdResourceView = "list" | "tree";

export type UiSettings = {
  readOnly: boolean;
  /** Per-view set of column keys the user has explicitly hidden. */
  hiddenColumns: Record<ColumnView, string[]>;
  /** Per-view ordered list of column keys. Empty = use descriptor default. */
  columnOrder: Record<ColumnView, string[]>;
  /** Per-action override of the default key chord (e.g. "Cmd+K" → "Ctrl+/"). */
  shortcuts: Record<string, string>;
  /** ArgoCD Application detail: managed-resources rendering mode. */
  argocdResourceView: ArgocdResourceView;
};

const STORAGE_KEY = UI_SETTINGS_STORAGE_KEY;

const EMPTY_HIDDEN: UiSettings["hiddenColumns"] = {
  "workloads-pod": [],
  "workloads-other": [],
  nodes: [],
};

const EMPTY_ORDER: UiSettings["columnOrder"] = {
  "workloads-pod": [],
  "workloads-other": [],
  nodes: [],
};

function defaults(): UiSettings {
  return {
    readOnly: false,
    hiddenColumns: { ...EMPTY_HIDDEN },
    columnOrder: { ...EMPTY_ORDER },
    shortcuts: {},
    argocdResourceView: "tree",
  };
}

function readPersisted(): UiSettings {
  if (typeof window === "undefined") return defaults();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    const hidden = (parsed.hiddenColumns ?? {}) as Partial<
      Record<ColumnView, unknown>
    >;
    const order = (parsed.columnOrder ?? {}) as Partial<
      Record<ColumnView, unknown>
    >;
    const safeArray = (
      bucket: Partial<Record<ColumnView, unknown>>,
      key: ColumnView,
    ): string[] => {
      const v = bucket[key];
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    };
    return {
      readOnly: parsed.readOnly === true,
      hiddenColumns: {
        "workloads-pod": safeArray(hidden, "workloads-pod"),
        "workloads-other": safeArray(hidden, "workloads-other"),
        nodes: safeArray(hidden, "nodes"),
      },
      columnOrder: {
        "workloads-pod": safeArray(order, "workloads-pod"),
        "workloads-other": safeArray(order, "workloads-other"),
        nodes: safeArray(order, "nodes"),
      },
      shortcuts:
        parsed.shortcuts && typeof parsed.shortcuts === "object"
          ? Object.fromEntries(
              Object.entries(parsed.shortcuts).filter(
                ([, v]) => typeof v === "string",
              ),
            )
          : {},
      argocdResourceView:
        parsed.argocdResourceView === "list" ||
        parsed.argocdResourceView === "tree"
          ? parsed.argocdResourceView
          : "tree",
    };
  } catch {
    return defaults();
  }
}

function writePersisted(settings: UiSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Best-effort persistence; no-op on quota / private-mode.
  }
}

type Store = UiSettings & {
  setReadOnly: (next: boolean) => void;
  toggleReadOnly: () => void;
  toggleColumn: (view: ColumnView, columnKey: string) => void;
  resetColumns: (view: ColumnView) => void;
  /**
   * Reorder a column relative to another in the same view. Both keys
   * must exist in the descriptor list; the resulting `columnOrder[view]`
   * is the full ordered list with `fromKey` placed at `toKey`'s
   * position. A no-op when the keys are equal or either is missing
   * from `allKeys`.
   *
   * The hook takes the descriptor's full key list so views with new
   * (unknown-to-the-store) columns get those columns spliced in at
   * their natural position — ordering remains forward-compatible.
   */
  moveColumn: (
    view: ColumnView,
    fromKey: string,
    toKey: string,
    allKeys: string[],
  ) => void;
  resetColumnOrder: (view: ColumnView) => void;
  setShortcut: (actionId: string, chord: string | null) => void;
  resetShortcuts: () => void;
  setArgocdResourceView: (next: ArgocdResourceView) => void;
};

export const useUiSettings = create<Store>((set, get) => {
  const initial = readPersisted();
  return {
    ...initial,
    setReadOnly: (next) => {
      const snapshot = { ...get(), readOnly: next };
      writePersisted(snapshot);
      set({ readOnly: next });
    },
    toggleReadOnly: () => {
      const next = !get().readOnly;
      const snapshot = { ...get(), readOnly: next };
      writePersisted(snapshot);
      set({ readOnly: next });
    },
    toggleColumn: (view, columnKey) => {
      const current = get().hiddenColumns[view];
      const isHidden = current.includes(columnKey);
      const nextList = isHidden
        ? current.filter((k) => k !== columnKey)
        : [...current, columnKey];
      const nextHidden = { ...get().hiddenColumns, [view]: nextList };
      const snapshot = { ...get(), hiddenColumns: nextHidden };
      writePersisted(snapshot);
      set({ hiddenColumns: nextHidden });
    },
    resetColumns: (view) => {
      const nextHidden = { ...get().hiddenColumns, [view]: [] };
      const snapshot = { ...get(), hiddenColumns: nextHidden };
      writePersisted(snapshot);
      set({ hiddenColumns: nextHidden });
    },
    moveColumn: (view, fromKey, toKey, allKeys) => {
      if (fromKey === toKey) return;
      if (!allKeys.includes(fromKey) || !allKeys.includes(toKey)) return;
      // Build the working order from allKeys, layered with the
      // user's prior preferences so unknown-to-the-store columns land
      // where the descriptor puts them.
      const stored = get().columnOrder[view];
      const seen = new Set<string>();
      const merged: string[] = [];
      // Prior preferences first (in their persisted order), filtered
      // to keys we still know about.
      for (const k of stored) {
        if (allKeys.includes(k) && !seen.has(k)) {
          merged.push(k);
          seen.add(k);
        }
      }
      // Then any descriptor keys we didn't already place, in their
      // natural order.
      for (const k of allKeys) {
        if (!seen.has(k)) {
          merged.push(k);
          seen.add(k);
        }
      }
      const fromIdx = merged.indexOf(fromKey);
      const toIdx = merged.indexOf(toKey);
      if (fromIdx === -1 || toIdx === -1) return;
      merged.splice(fromIdx, 1);
      merged.splice(toIdx, 0, fromKey);
      const nextOrder = { ...get().columnOrder, [view]: merged };
      const snapshot = { ...get(), columnOrder: nextOrder };
      writePersisted(snapshot);
      set({ columnOrder: nextOrder });
    },
    resetColumnOrder: (view) => {
      const nextOrder = { ...get().columnOrder, [view]: [] };
      const snapshot = { ...get(), columnOrder: nextOrder };
      writePersisted(snapshot);
      set({ columnOrder: nextOrder });
    },
    setShortcut: (actionId, chord) => {
      const next = { ...get().shortcuts };
      if (chord && chord.trim().length > 0) {
        next[actionId] = chord.trim();
      } else {
        delete next[actionId];
      }
      const snapshot = { ...get(), shortcuts: next };
      writePersisted(snapshot);
      set({ shortcuts: next });
    },
    resetShortcuts: () => {
      const snapshot = { ...get(), shortcuts: {} };
      writePersisted(snapshot);
      set({ shortcuts: {} });
    },
    setArgocdResourceView: (next) => {
      const snapshot = { ...get(), argocdResourceView: next };
      writePersisted(snapshot);
      set({ argocdResourceView: next });
    },
  };
});

/**
 * Apply a persisted column order to a descriptor list, then strip
 * hidden ones. `alwaysOn` columns are pinned to the head of the
 * resulting list regardless of the user's reorder, since they're the
 * row anchor.
 *
 * Pure helper exported for unit tests + reuse across views (Workloads,
 * Nodes). Not a hook — call inside `useMemo` from the view itself.
 */
export function applyColumnLayout<T extends { key: string; alwaysOn?: boolean }>(
  columns: T[],
  order: string[],
  hidden: string[],
): T[] {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const seen = new Set<string>();
  const ordered: T[] = [];

  // 1. Honor user order, ignoring keys we no longer know about.
  for (const key of order) {
    const col = byKey.get(key);
    if (col && !seen.has(key)) {
      ordered.push(col);
      seen.add(key);
    }
  }
  // 2. Append any descriptor columns the user hasn't explicitly placed
  //    yet, in their natural position. New columns added in a future
  //    update show up at the end of any prior reorder.
  for (const col of columns) {
    if (!seen.has(col.key)) {
      ordered.push(col);
      seen.add(col.key);
    }
  }

  // 3. Pin `alwaysOn` columns to the head, preserving their relative
  //    order. Keeps the row anchor (typically `name`) on the left even
  //    if the user dragged it elsewhere.
  const anchors = ordered.filter((c) => c.alwaysOn);
  const rest = ordered.filter((c) => !c.alwaysOn);
  const final = [...anchors, ...rest];

  // 4. Strip hidden — `alwaysOn` columns are protected here too, same
  //    rule the picker enforces.
  if (hidden.length === 0) return final;
  return final.filter((c) => c.alwaysOn || !hidden.includes(c.key));
}
