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

function defaults(): UiSettings {
  return {
    readOnly: false,
    hiddenColumns: { ...EMPTY_HIDDEN },
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
    const safeArray = (key: ColumnView): string[] => {
      const v = hidden[key];
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    };
    return {
      readOnly: parsed.readOnly === true,
      hiddenColumns: {
        "workloads-pod": safeArray("workloads-pod"),
        "workloads-other": safeArray("workloads-other"),
        nodes: safeArray("nodes"),
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
