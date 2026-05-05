import { create } from "zustand";

// Re-exported as a stable string so the consuming components don't import a
// magic literal — same pattern as THEME_STORAGE_KEY.
export const UI_SETTINGS_STORAGE_KEY = "lumen:ui-settings";

/**
 * Persisted UI preferences
 * ────────────────────────
 *
 * Distinct from `useUi` (transient UI state like palette-open) so the
 * persistence boundary is explicit. Right now this just owns `readOnly`,
 * but it's the right home for any future feature flags that should
 * survive an app restart (default-namespace, default-context, etc.).
 *
 * Read-only mode hides every destructive action across the app:
 * delete / scale / restart / cordon / drain / image-swap. The toggle
 * lives in the topbar (and command palette) so demo clusters or
 * shared shells stay safe.
 */

export type UiSettings = {
  readOnly: boolean;
};

const STORAGE_KEY = UI_SETTINGS_STORAGE_KEY;

function readPersisted(): UiSettings {
  if (typeof window === "undefined") return { readOnly: false };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { readOnly: false };
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    return { readOnly: parsed.readOnly === true };
  } catch {
    return { readOnly: false };
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
};

export const useUiSettings = create<Store>((set, get) => {
  const initial = readPersisted();
  return {
    ...initial,
    setReadOnly: (next) => {
      writePersisted({ readOnly: next });
      set({ readOnly: next });
    },
    toggleReadOnly: () => {
      const next = !get().readOnly;
      writePersisted({ readOnly: next });
      set({ readOnly: next });
    },
  };
});
