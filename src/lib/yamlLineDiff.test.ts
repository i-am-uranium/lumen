import { describe, expect, it } from "vitest";
import { yamlLineDiff } from "./yamlLineDiff";

describe("yamlLineDiff", () => {
  it("aligns inserted lines without marking following lines changed", () => {
    const result = yamlLineDiff(
      "kind: Pod\nmetadata:\n  name: api\n",
      "kind: Pod\n# comment\nmetadata:\n  name: api\n",
    );
    expect(result.limited).toBe(false);
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(0);
    expect(result.rows[1]).toEqual({
      before: null,
      after: { number: 2, text: "# comment" },
      changed: true,
    });
    expect(result.rows[2].changed).toBe(false);
  });
  it("preserves whitespace, empty drafts and final-newline changes", () => {
    expect(yamlLineDiff("a\n", "a").deletions).toBe(1);
    expect(yamlLineDiff("a", "").deletions).toBe(1);
    expect(yamlLineDiff("", "").rows).toEqual([]);
    const result = yamlLineDiff("  a: b", " a: b");
    expect(result.rows).toEqual([
      {
        before: { number: 1, text: "  a: b" },
        after: { number: 1, text: " a: b" },
        changed: true,
      },
    ]);
  });
  it("reconstructs both inputs even with repeated lines and multiple edits", () => {
    for (const [before, after] of [
      ["a\nb\na\nc", "a\na\nd\nc"],
      ["x\ny", "y\nx"],
      ["", "new\n"],
    ]) {
      const result = yamlLineDiff(before, after);
      expect(
        result.rows
          .flatMap((r) => (r.before ? [r.before.text] : []))
          .join("\n"),
      ).toBe(before);
      expect(
        result.rows.flatMap((r) => (r.after ? [r.after.text] : [])).join("\n"),
      ).toBe(after);
    }
  });
  it("bounds expensive comparisons and rendering with an explicit fallback", () => {
    const result = yamlLineDiff(
      Array.from({ length: 2000 }, (_, i) => `old-${i}`).join("\n"),
      Array.from({ length: 2000 }, (_, i) => `new-${i}`).join("\n"),
    );
    expect(result.limited).toBe(true);
    expect(result.rows).toHaveLength(0);
    expect(result.additions).toBeNull();
  });
});
