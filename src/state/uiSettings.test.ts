import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyColumnLayout,
  ARGOCD_DETAIL_PANEL_WIDTH_DEFAULT,
  ARGOCD_DETAIL_PANEL_WIDTH_MIN,
  UI_SETTINGS_STORAGE_KEY,
  useUiSettings,
} from "./uiSettings";

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
    columnOrder: {
      "workloads-pod": [],
      "workloads-other": [],
      nodes: [],
    },
    shortcuts: {},
    argocdResourceView: "tree",
    argocdDetailPanelWidth: ARGOCD_DETAIL_PANEL_WIDTH_DEFAULT,
    argocdTreeCollapsed: [],
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

  it("argocdDetailPanelWidth defaults to 460 and persists changes", () => {
    expect(useUiSettings.getState().argocdDetailPanelWidth).toBe(
      ARGOCD_DETAIL_PANEL_WIDTH_DEFAULT,
    );
    useUiSettings.getState().setArgocdDetailPanelWidth(600);
    expect(useUiSettings.getState().argocdDetailPanelWidth).toBe(600);
    const persisted = JSON.parse(
      window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY) ?? "{}",
    );
    expect(persisted.argocdDetailPanelWidth).toBe(600);
  });

  it("argocdDetailPanelWidth clamps below the minimum and rounds floats", () => {
    useUiSettings.getState().setArgocdDetailPanelWidth(100);
    expect(useUiSettings.getState().argocdDetailPanelWidth).toBe(
      ARGOCD_DETAIL_PANEL_WIDTH_MIN,
    );
    useUiSettings.getState().setArgocdDetailPanelWidth(512.7);
    expect(useUiSettings.getState().argocdDetailPanelWidth).toBe(513);
  });

  it("argocdDetailPanelWidth falls back to default for non-finite input", () => {
    useUiSettings.getState().setArgocdDetailPanelWidth(Number.NaN);
    expect(useUiSettings.getState().argocdDetailPanelWidth).toBe(
      ARGOCD_DETAIL_PANEL_WIDTH_DEFAULT,
    );
    useUiSettings
      .getState()
      .setArgocdDetailPanelWidth(Number.POSITIVE_INFINITY);
    expect(useUiSettings.getState().argocdDetailPanelWidth).toBe(
      ARGOCD_DETAIL_PANEL_WIDTH_DEFAULT,
    );
  });

  describe("column ordering (D10 finish)", () => {
    const allKeys = ["name", "ns", "kind", "ready", "age"];

    it("defaults columnOrder to empty (use descriptor order)", () => {
      expect(useUiSettings.getState().columnOrder["workloads-pod"]).toEqual([]);
    });

    it("moveColumn places fromKey at toKey's position", () => {
      useUiSettings
        .getState()
        .moveColumn("workloads-pod", "age", "kind", allKeys);
      expect(useUiSettings.getState().columnOrder["workloads-pod"]).toEqual([
        "name",
        "ns",
        "age",
        "kind",
        "ready",
      ]);
    });

    it("moveColumn round-trips through localStorage", () => {
      useUiSettings
        .getState()
        .moveColumn("workloads-pod", "age", "ns", allKeys);
      const persisted = JSON.parse(
        window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY) ?? "{}",
      );
      expect(persisted.columnOrder["workloads-pod"]).toEqual([
        "name",
        "age",
        "ns",
        "kind",
        "ready",
      ]);
    });

    it("moveColumn is a no-op when fromKey == toKey", () => {
      useUiSettings
        .getState()
        .moveColumn("workloads-pod", "age", "age", allKeys);
      expect(useUiSettings.getState().columnOrder["workloads-pod"]).toEqual([]);
    });

    it("moveColumn ignores keys missing from the descriptor", () => {
      useUiSettings
        .getState()
        .moveColumn("workloads-pod", "ghost", "name", allKeys);
      expect(useUiSettings.getState().columnOrder["workloads-pod"]).toEqual([]);
    });

    it("moveColumn preserves prior reorders across descriptor expansion", () => {
      useUiSettings
        .getState()
        .moveColumn("workloads-pod", "age", "ns", allKeys);
      const expanded = [...allKeys, "newcol"];
      useUiSettings
        .getState()
        .moveColumn("workloads-pod", "newcol", "kind", expanded);
      expect(useUiSettings.getState().columnOrder["workloads-pod"]).toEqual([
        "name",
        "age",
        "ns",
        "newcol",
        "kind",
        "ready",
      ]);
    });

    it("resetColumnOrder clears one view but leaves others alone", () => {
      useUiSettings
        .getState()
        .moveColumn("workloads-pod", "age", "ns", allKeys);
      useUiSettings
        .getState()
        .moveColumn("nodes", "kind", "name", allKeys);
      useUiSettings.getState().resetColumnOrder("workloads-pod");
      expect(useUiSettings.getState().columnOrder["workloads-pod"]).toEqual([]);
      expect(useUiSettings.getState().columnOrder.nodes).not.toEqual([]);
    });
  });
});

describe("applyColumnLayout", () => {
  type Col = { key: string; alwaysOn?: boolean };
  const cols: Col[] = [
    { key: "name", alwaysOn: true },
    { key: "ns" },
    { key: "kind" },
    { key: "ready" },
    { key: "age" },
  ];

  it("returns descriptor order when no overrides are present", () => {
    expect(applyColumnLayout(cols, [], []).map((c) => c.key)).toEqual([
      "name",
      "ns",
      "kind",
      "ready",
      "age",
    ]);
  });

  it("honors a custom order while pinning alwaysOn columns to the head", () => {
    expect(
      applyColumnLayout(cols, ["age", "kind", "ns", "name", "ready"], []).map(
        (c) => c.key,
      ),
    ).toEqual(["name", "age", "kind", "ns", "ready"]);
  });

  it("appends new (not-yet-ordered) columns at their natural position", () => {
    expect(
      applyColumnLayout(cols, ["age", "kind"], []).map((c) => c.key),
    ).toEqual(["name", "age", "kind", "ns", "ready"]);
  });

  it("strips hidden columns but never the alwaysOn anchor", () => {
    expect(
      applyColumnLayout(cols, [], ["name", "kind"]).map((c) => c.key),
    ).toEqual(["name", "ns", "ready", "age"]);
  });

  it("ignores stale keys from the persisted order", () => {
    expect(
      applyColumnLayout(cols, ["ghost", "age", "ns"], []).map((c) => c.key),
    ).toEqual(["name", "age", "ns", "kind", "ready"]);
  });
});

describe("argocd resource view + tree collapse (PR #48)", () => {
  it("argocdResourceView accepts the new 'topology' value", () => {
    useUiSettings.getState().setArgocdResourceView("topology");
    expect(useUiSettings.getState().argocdResourceView).toBe("topology");
    const persisted = JSON.parse(
      window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY) ?? "{}",
    );
    expect(persisted.argocdResourceView).toBe("topology");
  });

  it("argocdTreeCollapsed defaults empty and toggles by kind", () => {
    expect(useUiSettings.getState().argocdTreeCollapsed).toEqual([]);
    useUiSettings.getState().toggleArgocdTreeKind("ConfigMap");
    expect(useUiSettings.getState().argocdTreeCollapsed).toEqual(["ConfigMap"]);
    useUiSettings.getState().toggleArgocdTreeKind("Secret");
    expect(useUiSettings.getState().argocdTreeCollapsed).toEqual([
      "ConfigMap",
      "Secret",
    ]);
    // Toggling again removes that kind only.
    useUiSettings.getState().toggleArgocdTreeKind("ConfigMap");
    expect(useUiSettings.getState().argocdTreeCollapsed).toEqual(["Secret"]);
    const persisted = JSON.parse(
      window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY) ?? "{}",
    );
    expect(persisted.argocdTreeCollapsed).toEqual(["Secret"]);
  });

  it("resetArgocdTreeCollapsed clears the collapsed set", () => {
    useUiSettings.getState().toggleArgocdTreeKind("ConfigMap");
    useUiSettings.getState().toggleArgocdTreeKind("Secret");
    useUiSettings.getState().resetArgocdTreeCollapsed();
    expect(useUiSettings.getState().argocdTreeCollapsed).toEqual([]);
  });
});
