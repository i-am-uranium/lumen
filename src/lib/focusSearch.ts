/**
 * Tiny pub/sub for the "focus the current view's search input" intent.
 *
 * The Cmd+/ shortcut lives in App.tsx, but the input that should receive
 * focus depends on whatever view is currently mounted (workloads, events,
 * etc.). Rather than thread a ref through router state, the shortcut
 * dispatches a window-level CustomEvent and views opt-in by listening for
 * it via `useFocusSearch`. Keeps view code purely declarative — no global
 * registry, no manual cleanup, and no coupling to route paths.
 */

import { useEffect } from "react";

export const FOCUS_SEARCH_EVENT = "lumen:focus-search";

/**
 * Subscribe to the focus-search broadcast for the lifetime of the
 * component. Pass an optional ref callback to focus + select an input.
 */
export function useFocusSearch(onFocus: () => void): void {
  useEffect(() => {
    const handler = () => onFocus();
    window.addEventListener(FOCUS_SEARCH_EVENT, handler);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, handler);
  }, [onFocus]);
}

/** Fire the broadcast. Called by the global Cmd+/ keybinding. */
export function dispatchFocusSearch(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT));
}
