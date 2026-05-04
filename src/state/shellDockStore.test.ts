import { describe, it, expect, beforeEach } from "vitest";
import { useShellDockStore } from "./shellDockStore";

const KEY = {
  pod: "p1",
  namespace: "ns1",
  context: "ctx1",
  container: "app",
  command: ["/bin/sh"],
};

describe("useShellDockStore", () => {
  beforeEach(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("lumen:shell-dock:mru");
    }
    useShellDockStore.setState({ tabs: [], activeTabId: null, isOpen: false, mru: [] });
  });

  it("openSession appends a tab and opens the dock", () => {
    const id = useShellDockStore.getState().openSession(KEY);
    const s = useShellDockStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].id).toBe(id);
    expect(s.activeTabId).toBe(id);
    expect(s.isOpen).toBe(true);
  });

  it("openSession twice creates two tabs, second is active", () => {
    const a = useShellDockStore.getState().openSession(KEY);
    const b = useShellDockStore.getState().openSession({ ...KEY, container: "sidecar" });
    const s = useShellDockStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual([a, b]);
    expect(s.activeTabId).toBe(b);
  });

  it("closeTab removes the tab and selects neighbor", () => {
    const store = useShellDockStore.getState();
    const a = store.openSession(KEY);
    const b = store.openSession({ ...KEY, container: "sidecar" });
    useShellDockStore.getState().closeTab(b);
    const s = useShellDockStore.getState();
    expect(s.tabs.map((t) => t.id)).toEqual([a]);
    expect(s.activeTabId).toBe(a);
  });

  it("closeDock closes all sessions and hides", () => {
    const store = useShellDockStore.getState();
    store.openSession(KEY);
    store.openSession({ ...KEY, container: "sidecar" });
    useShellDockStore.getState().closeDock();
    const s = useShellDockStore.getState();
    expect(s.tabs).toHaveLength(0);
    expect(s.isOpen).toBe(false);
  });

  it("commandLabel uses basename of first arg", () => {
    useShellDockStore.getState().openSession({ ...KEY, command: ["/bin/bash"] });
    expect(useShellDockStore.getState().tabs[0].commandLabel).toBe("bash");
  });
});

describe("useShellDockStore — MRU", () => {
  beforeEach(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("lumen:shell-dock:mru");
    }
    useShellDockStore.setState({ tabs: [], activeTabId: null, isOpen: false, mru: [] });
  });

  it("openSession adds to MRU", () => {
    useShellDockStore.getState().openSession(KEY);
    const m = useShellDockStore.getState().mru;
    expect(m).toHaveLength(1);
    expect(m[0].pod).toBe("p1");
  });

  it("MRU dedups by pod+namespace+context (different containers collapse)", () => {
    const store = useShellDockStore.getState();
    store.openSession(KEY);
    store.openSession({ ...KEY, container: "sidecar" });
    const m = useShellDockStore.getState().mru;
    expect(m).toHaveLength(1);
    expect(m[0].container).toBe("sidecar"); // most recent wins
  });

  it("MRU preserves separate entries across different namespaces", () => {
    const store = useShellDockStore.getState();
    store.openSession(KEY);
    store.openSession({ ...KEY, namespace: "ns2" });
    const m = useShellDockStore.getState().mru;
    expect(m).toHaveLength(2);
    expect(m[0].namespace).toBe("ns2");
    expect(m[1].namespace).toBe("ns1");
  });

  it("MRU caps at 8 entries", () => {
    const store = useShellDockStore.getState();
    for (let i = 0; i < 12; i++) {
      store.openSession({ ...KEY, pod: `pod-${i}` });
    }
    const m = useShellDockStore.getState().mru;
    expect(m).toHaveLength(8);
    expect(m[0].pod).toBe("pod-11");
    expect(m[7].pod).toBe("pod-4");
  });

  it("MRU persists to localStorage", () => {
    useShellDockStore.getState().openSession(KEY);
    const raw = window.localStorage.getItem("lumen:shell-dock:mru");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].pod).toBe("p1");
  });

  it("addToMru moves existing entry to front", () => {
    const store = useShellDockStore.getState();
    store.addToMru(KEY);
    store.addToMru({ ...KEY, pod: "p2" });
    store.addToMru(KEY); // re-touch p1
    const m = useShellDockStore.getState().mru;
    expect(m.map((e) => e.pod)).toEqual(["p1", "p2"]);
  });
});
