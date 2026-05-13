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

export type ShortcutScope =
  /** Fires anywhere in the app (default). */
  | "global"
  /** Fires only when the resource detail drawer is open. */
  | "drawer";

export type ShortcutAction = {
  id: string;
  label: string;
  description: string;
  /** The chord that ships out-of-the-box — overridable per user. */
  defaultChord: string;
  /**
   * Where the chord applies. `global` (default) listens unconditionally;
   * scoped chords (e.g. drawer hotkeys) only fire when the owner passes
   * `{ enabled: true }` to useShortcut. The Settings UI surfaces the scope
   * as a small hint label so users understand why a chord may not respond
   * outside of its context.
   */
  scope?: ShortcutScope;
};

export const REGISTRY: ShortcutAction[] = [
  {
    id: "openPalette",
    label: "Open command palette",
    description:
      "Toggles the palette over the current view. Search resources, switch contexts, run actions.",
    defaultChord: "Cmd+K",
  },
  {
    id: "openLogs",
    label: "Open logs view",
    description:
      "Jumps to the cluster-wide logs route for the current context.",
    defaultChord: "Cmd+L",
  },
  {
    id: "focusSearch",
    label: "Focus search",
    description:
      "Focuses the in-page search/filter input on the current view (workloads, events, etc.).",
    defaultChord: "Cmd+/",
  },
  {
    id: "newTab",
    label: "Open new tab",
    description:
      "Opens a fresh tab on the fleet view. Use to keep multiple clusters or resources open side-by-side.",
    defaultChord: "Cmd+T",
  },
  {
    id: "closeTab",
    label: "Close current tab",
    description:
      "Closes the active tab. Closing the last tab resets it to the fleet view.",
    defaultChord: "Cmd+W",
  },
  {
    id: "nextTab",
    label: "Next tab",
    description: "Cycles forward through open tabs, wrapping at the end.",
    defaultChord: "Cmd+Shift+]",
  },
  {
    id: "prevTab",
    label: "Previous tab",
    description: "Cycles backward through open tabs, wrapping at the start.",
    defaultChord: "Cmd+Shift+[",
  },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map(
    (n): ShortcutAction => ({
      id: `jumpTab${n}`,
      label: `Jump to tab ${n}`,
      description:
        n === 9
          ? "Jumps to the rightmost tab in the strip."
          : `Activates the ${ordinal(n)} tab in the strip (pinned tabs count first).`,
      defaultChord: `Cmd+${n}`,
    }),
  ),
  {
    id: "drawerLogs",
    label: "Drawer: open logs tab",
    description: "Opens the logs tab inside the resource detail drawer.",
    defaultChord: "L",
    scope: "drawer",
  },
  {
    id: "drawerShell",
    label: "Drawer: open shell",
    description:
      "Opens an exec shell for the focused pod (drawer must be open).",
    defaultChord: "S",
    scope: "drawer",
  },
  {
    id: "drawerDownload",
    label: "Drawer: download logs",
    description:
      "Downloads the focused pod's logs (drawer must be open).",
    defaultChord: "D",
    scope: "drawer",
  },
  {
    id: "drawerYaml",
    label: "Drawer: open YAML tab",
    description: "Switches the resource detail drawer to the YAML tab.",
    defaultChord: "Y",
    scope: "drawer",
  },
  {
    id: "drawerClose",
    label: "Drawer: close",
    description: "Closes the resource detail drawer.",
    defaultChord: "Esc",
    scope: "drawer",
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

export type UseShortcutOptions = {
  /**
   * When false, the listener is not registered. Lets context-scoped chords
   * (e.g. drawer hotkeys) opt-in/out without conditionally calling the hook —
   * the React rules-of-hooks would complain otherwise.
   */
  enabled?: boolean;
  /**
   * When true, the handler is suppressed if the keydown originates inside
   * an editable field. Defaults to true for unmodified, single-character
   * chords (so "L" / "Y" don't fire while typing in a search input) and
   * false for chords with Cmd/Ctrl/Alt held.
   */
  ignoreWhileTyping?: boolean;
};

function eventTargetIsEditable(e: KeyboardEvent): boolean {
  const t = e.target;
  if (!t) return false;
  if (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement
  ) {
    return true;
  }
  if (t instanceof HTMLElement && t.isContentEditable) return true;
  return false;
}

/**
 * Hook: register a global keydown handler for the given action id.
 * Re-resolves the effective chord whenever overrides change so the
 * user-edited binding takes effect without a reload.
 *
 * Pass `{ enabled }` to gate context-scoped chords (e.g. drawer hotkeys
 * that should only fire while the drawer is open).
 */
export function useShortcut(
  actionId: string,
  handler: (e: KeyboardEvent) => void,
  options: UseShortcutOptions = {},
): void {
  const override = useUiSettings((s) => s.shortcuts[actionId]);
  const action = REGISTRY.find((a) => a.id === actionId);
  const chord = override ?? action?.defaultChord ?? "";
  const { enabled = true, ignoreWhileTyping } = options;
  useEffect(() => {
    if (!enabled) return;
    const parsed = parseChord(chord);
    if (!parsed) return;
    const guardTyping =
      ignoreWhileTyping ??
      (!parsed.cmdOrCtrl && !parsed.alt && parsed.key.length === 1);
    const onKey = (e: KeyboardEvent) => {
      if (!matchEvent(e, parsed)) return;
      if (guardTyping && eventTargetIsEditable(e)) return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chord, handler, enabled, ignoreWhileTyping]);
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

function ordinal(n: number): string {
  const suffix = ["th", "st", "nd", "rd"][n % 10 < 4 && (n % 100 < 11 || n % 100 > 13) ? n % 10 : 0];
  return `${n}${suffix}`;
}
