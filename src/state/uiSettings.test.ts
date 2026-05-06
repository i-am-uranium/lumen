import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UI_SETTINGS_STORAGE_KEY, useUiSettings } from "./uiSettings";

beforeEach(() => {
  window.localStorage.clear();
  // Reset in-memory state to the persisted default. Direct setState is fine
  // here — the store's lazy init only runs on module import.
  useUiSettings.setState({
    readOnly: false,
    hiddenColumns: {
      "workloads-pod": [],
      "workloads-other": [],
      nodes: [],
    },
    shortcuts: {},
    argocdResourceView: "tree",
  });
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
    const persisted = JSON.parse(
      window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY) ?? "{}",
    );
    expect(persisted.readOnly).toBe(true);

    useUiSettings.getState().setReadOnly(false);
    expect(useUiSettings.getState().readOnly).toBe(false);
  });

  it("toggleReadOnly flips the bit", () => {
    useUiSettings.getState().toggleReadOnly();
    expect(useUiSettings.getState().readOnly).toBe(true);
    useUiSettings.getState().toggleReadOnly();
    expect(useUiSettings.getState().readOnly).toBe(false);
  });

  it("toggleColumn round-trips through localStorage", () => {
    useUiSettings.getState().toggleColumn("workloads-pod", "qos");
    expect(useUiSettings.getState().hiddenColumns["workloads-pod"]).toEqual([
      "qos",
    ]);
    const persisted = JSON.parse(
      window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY) ?? "{}",
    );
    expect(persisted.hiddenColumns["workloads-pod"]).toEqual(["qos"]);

    // Toggling again removes it.
    useUiSettings.getState().toggleColumn("workloads-pod", "qos");
    expect(useUiSettings.getState().hiddenColumns["workloads-pod"]).toEqual([]);
  });

  it("resetColumns clears one view but leaves others alone", () => {
    useUiSettings.getState().toggleColumn("workloads-pod", "qos");
    useUiSettings.getState().toggleColumn("nodes", "kernel");
    useUiSettings.getState().resetColumns("workloads-pod");
    expect(useUiSettings.getState().hiddenColumns["workloads-pod"]).toEqual([]);
    expect(useUiSettings.getState().hiddenColumns.nodes).toEqual(["kernel"]);
  });

  it("setShortcut writes overrides; null clears them", () => {
    useUiSettings.getState().setShortcut("openPalette", "Ctrl+/");
    expect(useUiSettings.getState().shortcuts.openPalette).toBe("Ctrl+/");
    useUiSettings.getState().setShortcut("openPalette", null);
    expect(useUiSettings.getState().shortcuts.openPalette).toBeUndefined();
  });

  it("argocdResourceView defaults to 'tree' and persists changes", () => {
    expect(useUiSettings.getState().argocdResourceView).toBe("tree");
    useUiSettings.getState().setArgocdResourceView("list");
    expect(useUiSettings.getState().argocdResourceView).toBe("list");
    const persisted = JSON.parse(
      window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY) ?? "{}",
    );
    expect(persisted.argocdResourceView).toBe("list");
  });
});
