import { useShellDockStore } from "@/state/shellDockStore";
import type { ShellSessionKey } from "@/state/shellSession";

export type UseShellDock = {
  openSession: (key: ShellSessionKey) => string;
  closeTab: (id: string) => void;
  closeDock: () => void;
};

/**
 * Imperative handle for opening shell sessions from anywhere in the app
 * (drawer Shell action, CloudMap, command palette, etc.). Designed so
 * call sites don't need to read the dock state — they just dispatch.
 */
export function useShellDock(): UseShellDock {
  const openSession = useShellDockStore((s) => s.openSession);
  const closeTab = useShellDockStore((s) => s.closeTab);
  const closeDock = useShellDockStore((s) => s.closeDock);
  return { openSession, closeTab, closeDock };
}
