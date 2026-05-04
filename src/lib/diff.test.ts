import { describe, it, expect } from "vitest";
import { computeDiff, isNoOp } from "./diff";

describe("computeDiff", () => {
  it("classifies adds, changes, removes", () => {
    const before = { A: "1", B: "2", C: "3" };
    const after = { A: "1", B: "2x", D: "4" };
    const d = computeDiff(before, after);
    expect(d.adds).toEqual([{ key: "D", value: "4" }]);
    expect(d.changes).toEqual([{ key: "B", before: "2", after: "2x" }]);
    expect(d.removes).toEqual([{ key: "C", before: "3" }]);
    expect(d.unchanged).toEqual(["A"]);
  });

  it("returns empty-everything when maps are identical", () => {
    const m = { A: "1", B: "2" };
    const d = computeDiff(m, m);
    expect(d.adds).toEqual([]);
    expect(d.changes).toEqual([]);
    expect(d.removes).toEqual([]);
    expect(d.unchanged).toEqual(["A", "B"]);
    expect(isNoOp(d)).toBe(true);
  });

  it("isNoOp false when any category non-empty", () => {
    const d = computeDiff({}, { A: "x" });
    expect(isNoOp(d)).toBe(false);
  });
});
