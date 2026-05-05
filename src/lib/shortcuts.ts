/**
 * Global keyboard shortcut registry (D7 stretch).
 *
 * Centralizes the global app-level chords so users can override them
 * from the Settings page. Per-context shortcuts (e.g. drawer hotkeys
 * inside ResourceDetailDrawer, palette navigation keys) intentionally
 * stay local — the registry only owns chords that fire from anywhere
 * in the app.
 *
 * Chord format
 * ────────────
 * Strings like "Cmd+K", "Ctrl+/", "Shift+?", "Esc". Modifiers are
 * normalized to: Cmd (⌘), Ctrl, Shift, Alt. The matcher accepts
 * Cmd OR Ctrl interchangeably to match the Lumen-wide convention
 * (works on macOS and Windows/Linux without per-platform binds).
 *
 * Adding a new shortcut
 * ─────────────────────
 * 1. Add a `ShortcutAction` entry below.
 * 2. Wire `useShortcut(actionId, handler)` in the component that owns
 *    the behaviour. The hook handles registration + key matching.
 * 3. The Settings UI picks it up automatically via REGISTRY.
 */

import { useEffect } from "react";
import { useUiSettings } from "@/state/uiSettings";

export type ShortcutAction = {
  id: string;
  label: string;
  description: string;
  /** The chord that ships out-of-the-box — overridable per user. */
  defaultChord: string;
};

export const REGISTRY: ShortcutAction[] = [
  {
    id: "openPalette",
    label: "Open command palette",
    description:
      "Toggles the palette over the current view. Search resources, switch contexts, run actions.",
    defaultChord: "Cmd+K",
  },
];

/** Look up the active chord (override if set, else default). */
export function effectiveChord(actionId: string): string {
  const overrides = useUiSettings.getState().shortcuts;
  if (overrides[actionId]) return overrides[actionId];
  const action = REGISTRY.find((a) => a.id === actionId);
  return action?.defaultChord ?? "";
}

/**
 * Parse a chord string into the structured shape we match against.
 * Returns null on garbage input — the caller can fall back to the
 * default. We accept "Cmd+K", "ctrl+/", "Esc", " esc ", etc.
 */
export type ParsedChord = {
  cmdOrCtrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Lowercased single key, e.g. "k", "/", "escape". */
  key: string;
};

export function parseChord(chord: string): ParsedChord | null {
  if (!chord) return null;
  const parts = chord
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  let cmdOrCtrl = false;
  let shift = false;
  let alt = false;
  let key = "";
  for (const p of parts) {
    if (p === "cmd" || p === "meta" || p === "⌘") cmdOrCtrl = true;
    else if (p === "ctrl" || p === "control") cmdOrCtrl = true;
    else if (p === "shift") shift = true;
    else if (p === "alt" || p === "option" || p === "⌥") alt = true;
    else if (p === "esc") key = "escape";
    else key = p;
  }
  if (!key) return null;
  return { cmdOrCtrl, shift, alt, key };
}

export function matchEvent(e: KeyboardEvent, parsed: ParsedChord): boolean {
  const cmdOrCtrl = e.metaKey || e.ctrlKey;
  if (parsed.cmdOrCtrl !== cmdOrCtrl) return false;
  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.alt !== e.altKey) return false;
  // Compare the printable key, lowercased. captureChord stores whatever
  // e.key produced for the user (so Shift+/ becomes "Shift+?" on US
  // layouts) — this matches that exactly. We intentionally don't try
  // to be smart about layout-independent codes; that's a complexity
  // tax the registry doesn't earn back yet.
  return e.key.toLowerCase() === parsed.key;
}

/**
 * Hook: register a global keydown handler for the given action id.
 * Re-resolves the effective chord whenever overrides change so the
 * user-edited binding takes effect without a reload.
 */
export function useShortcut(
  actionId: string,
  handler: (e: KeyboardEvent) => void,
): void {
  const override = useUiSettings((s) => s.shortcuts[actionId]);
  const action = REGISTRY.find((a) => a.id === actionId);
  const chord = override ?? action?.defaultChord ?? "";
  useEffect(() => {
    const parsed = parseChord(chord);
    if (!parsed) return;
    const onKey = (e: KeyboardEvent) => {
      if (matchEvent(e, parsed)) {
        e.preventDefault();
        handler(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chord, handler]);
}

/**
 * Capture a single keypress and return its chord string. Used by the
 * Settings UI's "press a key" recorder. Returns the cleanup function.
 */
export function captureChord(
  onCapture: (chord: string | null) => void,
): () => void {
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    if (e.key === "Escape") {
      onCapture(null);
      return;
    }
    // Modifier-only presses get ignored; we want a real key.
    const mods = ["Meta", "Control", "Shift", "Alt"];
    if (mods.includes(e.key)) return;
    const parts: string[] = [];
    if (e.metaKey || e.ctrlKey) parts.push("Cmd");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");
    parts.push(e.key.length === 1 ? e.key.toUpperCase() : capitalize(e.key));
    onCapture(parts.join("+"));
  };
  window.addEventListener("keydown", onKey, { capture: true });
  return () => window.removeEventListener("keydown", onKey, { capture: true });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
