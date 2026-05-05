import { describe, it, expect } from "vitest";
import { mergeAndFilter } from "./useTabView";
import type { LogLine } from "@/state/logs";

const line = (id: number, arrivedAt: number, text: string): LogLine => ({
  pod: "p", container: "c", text, id, arrivedAt,
});

describe("mergeAndFilter", () => {
  it("merges two streams in arrival order", () => {
    const a = [line(0, 100, "a0"), line(1, 300, "a1")];
    const b = [line(0, 200, "b0"), line(1, 400, "b1")];
    const out = mergeAndFilter([a, b], { query: "", regex: false, caseSensitive: false, levels: null });
    expect(out.lines.map((l) => l.text)).toEqual(["a0", "b0", "a1", "b1"]);
  });

  it("caps merged result at 10_000 and reports drop", () => {
    const big = Array.from({ length: 12_000 }, (_, i) => line(i, i, `${i}`));
    const out = mergeAndFilter([big], { query: "", regex: false, caseSensitive: false, levels: null });
    expect(out.lines).toHaveLength(10_000);
    expect(out.mergedDropCount).toBe(2_000);
    expect(out.lines[0].text).toBe("2000");
    expect(out.lines[9_999].text).toBe("11999");
  });

  it("substring search returns match indices", () => {
    const a = [line(0, 1, "hello world"), line(1, 2, "goodbye"), line(2, 3, "world cup")];
    const out = mergeAndFilter([a], { query: "world", regex: false, caseSensitive: false, levels: null });
    expect(out.matches).toEqual([0, 2]);
  });

  it("regex search compiles once; invalid regex returns empty matches", () => {
    const a = [line(0, 1, "abc 123"), line(1, 2, "xyz")];
    const ok = mergeAndFilter([a], { query: "\\d+", regex: true, caseSensitive: false, levels: null });
    expect(ok.matches).toEqual([0]);
    const bad = mergeAndFilter([a], { query: "[unclosed", regex: true, caseSensitive: false, levels: null });
    expect(bad.matches).toEqual([]);
    expect(bad.regexError).toBeTruthy();
  });

  it("case-sensitive substring respects case", () => {
    const a = [line(0, 1, "Foo"), line(1, 2, "foo"), line(2, 3, "FOO")];
    const out = mergeAndFilter([a], { query: "foo", regex: false, caseSensitive: true, levels: null });
    expect(out.matches).toEqual([1]);
  });

  it("level filter hides bracket-level lines outside the set", () => {
    const a = [
      line(0, 1, "[INFO] hello"),
      line(1, 2, "[ERROR] bang"),
      line(2, 3, "no level here"),
    ];
    const out = mergeAndFilter([a], {
      query: "", regex: false, caseSensitive: false,
      levels: new Set(["error"]),
    });
    // ERROR line + the unparseable line are kept (we never hide unknown levels).
    expect(out.lines.map((l) => l.text)).toEqual(["[ERROR] bang", "no level here"]);
  });

  it("preserves per-line pod attribution across cross-pod merge", () => {
    // Aggregate-panel scenario: 3 pods interleaved by wall-clock arrival.
    // Pod identity must survive the merge so the row gutter and AI summary
    // payload can attribute each line to the right pod.
    const podLine = (pod: string, arrivedAt: number, text: string): LogLine => ({
      pod, container: "main", text, id: arrivedAt, arrivedAt,
    });
    const api = [podLine("api-1", 100, "boot"), podLine("api-1", 400, "ready")];
    const worker = [podLine("worker-1", 200, "tick"), podLine("worker-1", 500, "tock")];
    const cron = [podLine("cron-1", 300, "fire")];
    const out = mergeAndFilter([api, worker, cron], {
      query: "", regex: false, caseSensitive: false, levels: null,
    });
    expect(out.lines.map((l) => `${l.pod}:${l.text}`)).toEqual([
      "api-1:boot",
      "worker-1:tick",
      "cron-1:fire",
      "api-1:ready",
      "worker-1:tock",
    ]);
  });
});
