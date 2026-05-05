import { create } from "zustand";

/**
 * Theme model
 * ───────────
 *
 * Three persisted modes:
 *   - "light" / "dark" — explicit user choice
 *   - "system"          — follow `prefers-color-scheme` and update live
 *
 * The "applied" theme — what actually drives `data-theme` on the root
 * element — is always concrete (light or dark). The store tracks both:
 * `mode` is what the user chose, `applied` is what's currently rendered.
 *
 * The pre-paint script in index.html reads the persisted mode synchronously
 * and sets `data-theme` *before* React mounts so the first frame matches.
 * After mount, ThemeProvider reconciles in case anything changed (e.g.
 * the user toggled OS dark mode while the app was in another tab).
 */

export type ThemeMode = "light" | "dark" | "system";
export type AppliedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "lumen:theme";

type ThemeStore = {
  mode: ThemeMode;
  applied: AppliedTheme;
  setMode: (mode: ThemeMode) => void;
  /** Re-evaluate `applied` from `mode` + current system preference. */
  recompute: () => void;
};

/**
 * Read the user's saved mode synchronously. Returns "system" on any error
 * (no localStorage in SSR/sandbox, JSON parse failure, etc.) so the
 * caller never has to handle null.
 */
export function readPersistedThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // localStorage blocked / quota exceeded / etc. — fall back to system.
  }
  return "system";
}

/**
 * Resolve a `mode` to a concrete applied theme. Pure helper so the
 * pre-paint script in index.html can reuse the same logic.
 */
export function resolveAppliedTheme(mode: ThemeMode): AppliedTheme {
  if (mode === "light" || mode === "dark") return mode;
  if (typeof window === "undefined" || typeof window.matchMedia === "undefined") {
    return "dark"; // Lumen's identity default when system pref is unknowable.
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function writePersistedThemeMode(mode: ThemeMode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Best-effort; persistence failures shouldn't block theme switching.
  }
}

function applyDataTheme(theme: AppliedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  // Keep the legacy `dark` class in sync so Tailwind's `dark:` variant
  // (configured via darkMode: ["class"] in tailwind.config.js) tracks
  // the same source of truth as our CSS-token theme.
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

export const useThemeStore = create<ThemeStore>((set, get) => {
  const initialMode = readPersistedThemeMode();
  const initialApplied = resolveAppliedTheme(initialMode);
  // Pre-paint script normally beats us to this, but set defensively in case
  // the script was bypassed (hot reload mid-edit, test environment, etc.).
  applyDataTheme(initialApplied);
  return {
    mode: initialMode,
    applied: initialApplied,
    setMode: (mode) => {
      writePersistedThemeMode(mode);
      const applied = resolveAppliedTheme(mode);
      applyDataTheme(applied);
      set({ mode, applied });
    },
    recompute: () => {
      const applied = resolveAppliedTheme(get().mode);
      applyDataTheme(applied);
      set({ applied });
    },
  };
});

/**
 * Subscribe to system `prefers-color-scheme` changes and re-apply when
 * the user's mode is "system". Returns the unsubscribe function.
 *
 * Browsers fire this on OS dark-mode toggles. We don't unsubscribe
 * when mode flips away from "system" — the listener is cheap and
 * stays correct.
 */
export function watchSystemPreference(): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia === "undefined") {
    return () => undefined;
  }
  const mql = window.matchMedia("(prefers-color-scheme: light)");
  const handler = () => {
    const { mode, recompute } = useThemeStore.getState();
    if (mode === "system") recompute();
  };
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}
