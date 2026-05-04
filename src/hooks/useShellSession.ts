import { useCallback, useSyncExternalStore } from "react";
import type { ShellSession, ShellState } from "@/state/shellSession";

export type ShellSessionSnapshot = {
  state: ShellState;
  exitCode: number | null;
  errorMessage: string | null;
  scrollbackBytes: number;
  dropCount: number;
};

/**
 * Subscribe a component to a ShellSession's state changes. Output writes
 * (stdout/stderr) do NOT trigger re-renders — those go to xterm directly
 * via session.getScrollbackChunks() in Phase 2's ShellTerminalHost.
 *
 * Uses React 18's useSyncExternalStore with the session's version counter
 * as a primitive snapshot. Field-level values are read fresh on each
 * render after the version changes.
 */
export function useShellSession(session: ShellSession): ShellSessionSnapshot {
  const subscribe = useCallback(
    (onChange: () => void) => session.subscribe(onChange),
    [session],
  );
  useSyncExternalStore(subscribe, () => session.getVersion());
  return {
    state: session.getState(),
    exitCode: session.getExitCode(),
    errorMessage: session.getErrorMessage(),
    scrollbackBytes: session.getScrollbackBytes(),
    dropCount: session.getDropCount(),
  };
}
