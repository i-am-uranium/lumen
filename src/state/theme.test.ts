import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  readPersistedThemeMode,
  resolveAppliedTheme,
  useThemeStore,
} from "./theme";

/**
 * The store reads localStorage + matchMedia in its initializer (run once
 * at module import). Each test resets storage, mocks matchMedia, then
 * uses `useThemeStore.setState` to reset the in-memory state — that way
 * we exercise `setMode` / `recompute` against a known starting point
 * without re-importing the module.
 */

function mockMatchMedia(prefersLight: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query === "(prefers-color-scheme: light)" ? prefersLight : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("dark");
  mockMatchMedia(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readPersistedThemeMode", () => {
  it("returns 'system' when nothing is persisted", () => {
    expect(readPersistedThemeMode()).toBe("system");
  });

  it("returns the persisted mode when valid", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(readPersistedThemeMode()).toBe("light");
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(readPersistedThemeMode()).toBe("dark");
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    expect(readPersistedThemeMode()).toBe("system");
  });

  it("falls back to 'system' on garbage input — no throw", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon-cyber");
    expect(readPersistedThemeMode()).toBe("system");
  });
});

describe("resolveAppliedTheme", () => {
  it("explicit modes resolve to themselves", () => {
    expect(resolveAppliedTheme("light")).toBe("light");
    expect(resolveAppliedTheme("dark")).toBe("dark");
  });

  it("'system' follows prefers-color-scheme: light", () => {
    mockMatchMedia(true);
    expect(resolveAppliedTheme("system")).toBe("light");
  });

  it("'system' falls back to dark when OS prefers dark / unknown", () => {
    mockMatchMedia(false);
    expect(resolveAppliedTheme("system")).toBe("dark");
  });
});

describe("useThemeStore.setMode", () => {
  it("persists, applies data-theme, and toggles the dark class", () => {
    useThemeStore.getState().setMode("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    useThemeStore.getState().setMode("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("'system' picks light or dark based on current media query", () => {
    mockMatchMedia(true);
    useThemeStore.getState().setMode("system");
    expect(useThemeStore.getState().mode).toBe("system");
    expect(useThemeStore.getState().applied).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    mockMatchMedia(false);
    useThemeStore.getState().recompute();
    expect(useThemeStore.getState().applied).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
