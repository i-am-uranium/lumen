import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_SETTINGS_STORAGE_KEY, useUiSettings } from "./uiSettings";

beforeEach(() => {
  window.localStorage.clear();
  // Reset in-memory state to the persisted default. Direct setState is fine
  // here — the store's lazy init only runs on module import.
  useUiSettings.setState({ readOnly: false });
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useUiSettings", () => {
  it("defaults to readOnly=false when nothing is persisted", () => {
    expect(useUiSettings.getState().readOnly).toBe(false);
  });

  it("setReadOnly persists the value and updates state in lock-step", () => {
    useUiSettings.getState().setReadOnly(true);
    expect(useUiSettings.getState().readOnly).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY) ?? "{}"))
      .toEqual({ readOnly: true });

    useUiSettings.getState().setReadOnly(false);
    expect(useUiSettings.getState().readOnly).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY) ?? "{}"))
      .toEqual({ readOnly: false });
  });

  it("toggleReadOnly flips the bit", () => {
    useUiSettings.getState().toggleReadOnly();
    expect(useUiSettings.getState().readOnly).toBe(true);
    useUiSettings.getState().toggleReadOnly();
    expect(useUiSettings.getState().readOnly).toBe(false);
  });
});
