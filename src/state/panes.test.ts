import { beforeEach, describe, expect, it } from "vitest";
import { usePanesStore } from "./panes";

beforeEach(() => {
  usePanesStore.getState().reset();
  if (typeof window !== "undefined") {
    window.localStorage.removeItem("lumen-panes");
  }
});

describe("usePanesStore", () => {
  it("starts with exactly one focused pane", () => {
    const { panes, focusedId, sizes } = usePanesStore.getState();
    expect(panes).toHaveLength(1);
    expect(focusedId).toBe(panes[0].id);
    expect(sizes).toEqual([100]);
  });

  it("split clones the focused pane's url and focuses the new pane", () => {
    usePanesStore.getState().setPaneUrl(usePanesStore.getState().focusedId, "/cluster/prod/workloads");
    const newId = usePanesStore.getState().splitPane();
    const { panes, focusedId, sizes } = usePanesStore.getState();
    expect(panes).toHaveLength(2);
    expect(focusedId).toBe(newId);
    expect(panes[1].url).toBe("/cluster/prod/workloads");
    // 50/50 after the first split.
    expect(sizes.map((s) => Math.round(s))).toEqual([50, 50]);
  });

  it("split appends after the focused pane", () => {
    const first = usePanesStore.getState().focusedId;
    const second = usePanesStore.getState().splitPane();
    // Focus back to the leftmost pane and split again — new pane lands at index 1.
    usePanesStore.getState().focusPane(first);
    const third = usePanesStore.getState().splitPane();
    const panes = usePanesStore.getState().panes;
    expect(panes.map((p) => p.id)).toEqual([first, third, second]);
  });

  it("closePane is a no-op when only one pane remains", () => {
    const before = usePanesStore.getState();
    usePanesStore.getState().closePane(before.focusedId);
    const after = usePanesStore.getState();
    expect(after.panes).toEqual(before.panes);
    expect(after.focusedId).toBe(before.focusedId);
  });

  it("closing the focused pane focuses the right neighbor", () => {
    const a = usePanesStore.getState().focusedId;
    const b = usePanesStore.getState().splitPane();
    const c = usePanesStore.getState().splitPane();
    // Focus middle pane, then close it.
    usePanesStore.getState().focusPane(b);
    usePanesStore.getState().closePane(b);
    const state = usePanesStore.getState();
    expect(state.panes.map((p) => p.id)).toEqual([a, c]);
    expect(state.focusedId).toBe(c);
  });

  it("closing the rightmost focused pane falls back to the left", () => {
    const a = usePanesStore.getState().focusedId;
    const b = usePanesStore.getState().splitPane();
    usePanesStore.getState().closePane(b);
    expect(usePanesStore.getState().focusedId).toBe(a);
  });

  it("setPaneUrl updates a pane and is idempotent on no-change", () => {
    const id = usePanesStore.getState().focusedId;
    usePanesStore.getState().setPaneUrl(id, "/cluster/x");
    const first = usePanesStore.getState().panes;
    usePanesStore.getState().setPaneUrl(id, "/cluster/x");
    expect(usePanesStore.getState().panes).toBe(first);
  });

  it("focusNext / focusPrev cycle the focus with wrap-around", () => {
    const a = usePanesStore.getState().focusedId;
    const b = usePanesStore.getState().splitPane();
    const c = usePanesStore.getState().splitPane();
    usePanesStore.getState().focusPane(a);
    usePanesStore.getState().focusNext();
    expect(usePanesStore.getState().focusedId).toBe(b);
    usePanesStore.getState().focusNext();
    expect(usePanesStore.getState().focusedId).toBe(c);
    usePanesStore.getState().focusNext();
    expect(usePanesStore.getState().focusedId).toBe(a);
    usePanesStore.getState().focusPrev();
    expect(usePanesStore.getState().focusedId).toBe(c);
  });

  it("setSizes rejects mismatched lengths", () => {
    usePanesStore.getState().splitPane();
    const before = usePanesStore.getState().sizes;
    usePanesStore.getState().setSizes([100]);
    expect(usePanesStore.getState().sizes).toEqual(before);
    usePanesStore.getState().setSizes([30, 70]);
    expect(usePanesStore.getState().sizes).toEqual([30, 70]);
  });
});
