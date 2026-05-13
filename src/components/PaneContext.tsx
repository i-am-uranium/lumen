import { createContext, useContext, type ReactNode } from "react";

/**
 * Per-pane context. Components rendered inside a pane (TabBar, route
 * views like NamespacesView, ClusterWorkspace) read `paneId` from this
 * to scope their tabs and "open in new tab" operations to the correct
 * pane. Components rendered OUTSIDE all panes (NavBar, CommandPalette)
 * read the focused pane id from `usePanesStore` instead.
 */
const PaneContext = createContext<{ paneId: string } | null>(null);

export function PaneProvider({
  paneId,
  children,
}: {
  paneId: string;
  children: ReactNode;
}) {
  return <PaneContext.Provider value={{ paneId }}>{children}</PaneContext.Provider>;
}

/**
 * Resolve the enclosing pane's id. Throws when called outside a
 * `<PaneProvider>` — that's a programming error, not a runtime
 * fallback case (the missing context means we'd silently scope tabs
 * to the wrong pane otherwise).
 */
export function usePaneId(): string {
  const ctx = useContext(PaneContext);
  if (!ctx) {
    throw new Error("usePaneId() must be called inside <PaneProvider>");
  }
  return ctx.paneId;
}

/** Non-throwing variant for components that work both in and out of a pane. */
export function useOptionalPaneId(): string | null {
  return useContext(PaneContext)?.paneId ?? null;
}
