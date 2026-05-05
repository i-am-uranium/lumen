import { describe, expect, it } from "vitest";
import { matchEvent, parseChord } from "./shortcuts";

function buildEvent(
  key: string,
  opts: {
    code?: string;
    meta?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    alt?: boolean;
  } = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    code: opts.code ?? key,
    metaKey: opts.meta ?? false,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
  });
}

describe("parseChord", () => {
  it("handles common chord strings", () => {
    expect(parseChord("Cmd+K")).toEqual({
      cmdOrCtrl: true,
      shift: false,
      alt: false,
      key: "k",
    });
    expect(parseChord("Ctrl+Shift+/")).toEqual({
      cmdOrCtrl: true,
      shift: true,
      alt: false,
      key: "/",
    });
    expect(parseChord("Esc")).toEqual({
      cmdOrCtrl: false,
      shift: false,
      alt: false,
      key: "escape",
    });
  });

  it("rejects empty / whitespace input", () => {
    expect(parseChord("")).toBeNull();
    expect(parseChord("Cmd+")).toBeNull();
  });
});

describe("matchEvent", () => {
  it("matches Cmd+K with metaKey OR ctrlKey", () => {
    const parsed = parseChord("Cmd+K")!;
    expect(matchEvent(buildEvent("k", { meta: true }), parsed)).toBe(true);
    expect(matchEvent(buildEvent("k", { ctrl: true }), parsed)).toBe(true);
    expect(matchEvent(buildEvent("k"), parsed)).toBe(false);
  });

  it("rejects when modifiers don't match", () => {
    const parsed = parseChord("Cmd+K")!;
    expect(
      matchEvent(buildEvent("k", { meta: true, shift: true }), parsed),
    ).toBe(false);
  });

  it("matches the exact e.key value lowercased", () => {
    // captureChord stores what e.key produced, so Shift+? matches a "?"
    // event with shift held — not a "/" event. Layout-aware matching is
    // explicitly not implemented (see matchEvent comment).
    const parsed = parseChord("Shift+?")!;
    expect(matchEvent(buildEvent("?", { shift: true }), parsed)).toBe(true);
    expect(matchEvent(buildEvent("/", { shift: true }), parsed)).toBe(false);
  });
});
