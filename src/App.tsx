import { useCallback, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { CommandPalette } from "@/components/CommandPalette";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { ActivityDrawer } from "@/components/ActivityDrawer";
import { SplitView } from "@/components/SplitView";
import { TABS_NEW_URL, useTabsStore } from "@/state/tabs";
import {
  ClusterSwitcher,
  clusterSwitchPath,
  useClusterContexts,
} from "@/components/ClusterSwitcher";
import { useActivityStream } from "@/state/activityStream";
import { useUiSettings } from "@/state/uiSettings";
import { ShellDock } from "@/components/shell/ShellDock";
import { k8s } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { Bell, Columns2, Lock, Network } from "lucide-react";
import { useClusterStore } from "@/state/cluster";
import {
  navigateFocused,
  useFocusedPaneUrl,
  usePanesStore,
} from "@/state/panes";
import { useShortcut } from "@/lib/shortcuts";
import { dispatchFocusSearch } from "@/lib/focusSearch";
import { checkForAppUpdate } from "@/lib/autoUpdater";
import { APP_VERSION } from "@/lib/appInfo";

const qc = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

/** Split a "/path?query" string into its components, matching useLocation. */
function splitUrl(url: string): { pathname: string; search: string } {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return { pathname: url, search: "" };
  return { pathname: url.slice(0, qIdx), search: url.slice(qIdx) };
}

function StatusBar() {
  const focusedUrl = useFocusedPaneUrl();
  const { pathname } = splitUrl(focusedUrl);
  const { contextName, namespace } = useClusterStore();
  const { data: ctxs = [] } = useQuery(useClusterContexts(pathname.startsWith("/cluster")));
  const activeCtx = ctxs.find((c) => c.name === contextName);

  return (
    <div className="flex items-center justify-between h-9 px-4 text-[12px] border-t border-term-border-soft bg-term-panel text-term-muted">
      <div className="flex min-w-0 items-center gap-2">
        <Network className="size-3.5 shrink-0 text-term-green" aria-hidden="true" />
        <span className={cn("truncate", activeCtx?.is_prod && "text-term-amber")}>
          ctx: {contextName ?? "fleet"}
        </span>
        {namespace && (
          <>
            <span className="text-term-subtle">/</span>
            <span className="truncate">ns: {namespace}</span>
          </>
        )}
      </div>
      <div className="hidden sm:flex items-center gap-4">
        <span className="font-mono text-term-subtle">v{APP_VERSION}</span>
        <span><kbd className="text-term-fg">Cmd K</kbd> palette</span>
        <span><kbd className="text-term-fg">Cmd /</kbd> filter</span>
        <span><kbd className="text-term-fg">Cmd L</kbd> logs</span>
        <span><kbd className="text-term-fg">Cmd \</kbd> split</span>
      </div>
    </div>
  );
}

function ReadOnlyChip() {
  const readOnly = useUiSettings((s) => s.readOnly);
  const toggle = useUiSettings((s) => s.toggleReadOnly);
  if (!readOnly) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      title="Read-only mode is on — click to disable"
      className="ml-2 inline-flex items-center gap-1 rounded-[4px] border border-warning/40 bg-warning-soft px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-warning hover:bg-warning/15"
    >
      <Lock className="size-3" aria-hidden="true" />
      read-only
    </button>
  );
}

function NavBar() {
  const queryClient = useQueryClient();
  const focusedId = usePanesStore((s) => s.focusedId);
  const focusedUrl = useFocusedPaneUrl();
  const splitPane = usePanesStore((s) => s.splitPane);
  const paneCount = usePanesStore((s) => s.panes.length);
  const { pathname, search } = splitUrl(focusedUrl);
  const { contextName, setContext } = useClusterStore();
  const { data: contexts = [] } = useQuery(useClusterContexts(pathname.startsWith("/cluster")));
  const activeContext = contexts.find((item) => item.name === contextName);
  const activeClusterPath = contextName
    ? pathname.startsWith(`/cluster/${encodeURIComponent(contextName)}`)
    : false;

  const startActivity = useActivityStream((s) => s.start);
  const stopActivity = useActivityStream((s) => s.stop);
  const unreadWarnings = useActivityStream((s) => s.unreadWarnings);
  const activeStreamCtx = useActivityStream((s) => s.context);
  const [activityOpen, setActivityOpen] = useState(false);

  useEffect(() => {
    if (contextName) {
      void startActivity(contextName);
    } else if (activeStreamCtx) {
      void stopActivity();
    }
  }, [contextName, activeStreamCtx, startActivity, stopActivity]);

  const switchContext = useCallback(
    async (nextContext: string, opts: { inNewTab?: boolean } = {}) => {
      if (!contextName) return;
      try {
        await k8s.setContext(nextContext);
        setContext(nextContext);
        const targetUrl = clusterSwitchPath(
          pathname,
          search,
          contextName,
          nextContext,
        );
        if (opts.inNewTab) {
          useTabsStore.getState().syncActiveUrl(focusedId, focusedUrl);
          useTabsStore.getState().openTab(focusedId, targetUrl);
        }
        navigateFocused(targetUrl);
        await queryClient.invalidateQueries({ queryKey: ["k8s", "contexts"] });
        await queryClient.invalidateQueries({ queryKey: ["k8s", "namespaces"] });
      } catch (error) {
        toast.error((error as Error).message ?? String(error));
        throw error;
      }
    },
    [contextName, focusedId, focusedUrl, pathname, queryClient, search, setContext],
  );

  return (
    <>
      <nav className="flex items-center gap-2 px-4 py-2 border-b border-term-border-soft bg-term-panel">
        <span className="mds-heading text-[19px] text-term-fg">lumen</span>
        {contextName && activeClusterPath ? (
          <ClusterSwitcher
            context={contextName}
            isProd={!!activeContext?.is_prod}
            cluster={activeContext?.cluster ?? null}
            contexts={contexts}
            onSwitchContext={switchContext}
            variant="top"
          />
        ) : (
          <span className="rounded-[4px] border border-term-green/40 bg-term-green/10 px-2 py-1 text-[11px] uppercase tracking-wide text-term-green">
            cluster
          </span>
        )}
        <ReadOnlyChip />
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => splitPane()}
          title={
            paneCount > 1
              ? `Split into another pane (Cmd+\\) · ${paneCount} open`
              : "Split into another pane (Cmd+\\)"
          }
          aria-label="Split pane"
          className={cn(
            "inline-flex h-8 items-center justify-center rounded-[6px] border border-term-border-soft bg-term-bg/70 px-2 text-term-muted transition-colors",
            "hover:border-accent-primary/35 hover:text-term-fg",
          )}
        >
          <Columns2 className="size-3.5" aria-hidden="true" />
          {paneCount > 1 && (
            <span className="ml-1 font-mono text-[10px]">{paneCount}</span>
          )}
        </button>
        <ThemeSwitcher />
        <button
          type="button"
          onClick={() => setActivityOpen((o) => !o)}
          title={
            unreadWarnings > 0
              ? `Activity · ${unreadWarnings} unread warning${unreadWarnings === 1 ? "" : "s"}`
              : "Cluster activity"
          }
          className={cn(
            "relative inline-flex h-8 items-center justify-center rounded-[6px] border border-term-border-soft bg-term-bg/70 px-2 text-term-muted transition-colors",
            "hover:border-accent-primary/35 hover:text-term-fg",
          )}
        >
          <Bell className="size-3.5" aria-hidden="true" />
          {unreadWarnings > 0 && (
            <span
              className="absolute -right-1 -top-1 inline-flex size-4 items-center justify-center rounded-full bg-warning text-[9px] font-mono text-[var(--term-btn-primary-fg)]"
              aria-label={`${unreadWarnings} unread warnings`}
            >
              {unreadWarnings > 9 ? "9+" : unreadWarnings}
            </span>
          )}
        </button>
      </nav>
      <ActivityDrawer open={activityOpen} onClose={() => setActivityOpen(false)} />
    </>
  );
}

/**
 * Two-way bridge between the focused pane's URL and `window.location`.
 *
 *   - On mount: if `window.location` already points somewhere
 *     interesting (deep link, refresh on a child route), adopt it into
 *     the focused pane so the user lands where they expect.
 *   - On focused-pane URL change: mirror via `history.replaceState` so
 *     the URL bar reflects the active view (deep links, bookmarks).
 *   - On `popstate` (browser back/forward): push the URL into the
 *     focused pane so the user's intent flows to the right place.
 *
 * The non-focused panes are deliberately *not* mirrored — their state
 * stays parked in `panesStore` until the user focuses them again.
 */
function FocusedPaneBrowserUrlBridge() {
  const focusedUrl = useFocusedPaneUrl();

  useEffect(() => {
    // Initial adoption: if the persisted focused pane URL is the
    // default and the URL bar carries something more specific (deep
    // link, refresh), use the URL bar as the source of truth.
    if (typeof window === "undefined") return;
    const winUrl = window.location.pathname + window.location.search;
    if (winUrl && winUrl !== "/" && winUrl !== focusedUrl) {
      usePanesStore.getState().setPaneUrl(usePanesStore.getState().focusedId, winUrl);
    }
    // Empty deps — runs once at mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const winUrl = window.location.pathname + window.location.search;
    if (winUrl !== focusedUrl) {
      window.history.replaceState({}, "", focusedUrl);
    }
  }, [focusedUrl]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPop = () => {
      const winUrl = window.location.pathname + window.location.search;
      usePanesStore
        .getState()
        .setPaneUrl(usePanesStore.getState().focusedId, winUrl);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return null;
}

/**
 * Mirrors the focused pane's URL into the global `useClusterStore`
 * and the underlying kubeconfig context. Previously this lived inside
 * `ClusterWorkspace`, but with split panes that route can mount in
 * multiple places at once — racing the singleton. Centralising it
 * here means whichever pane the user is focused on drives the global
 * context, and non-focused panes don't touch it.
 */
function FocusedPaneClusterSyncer() {
  const focusedUrl = useFocusedPaneUrl();
  const setContext = useClusterStore((s) => s.setContext);

  useEffect(() => {
    const { pathname } = splitUrl(focusedUrl);
    const parts = pathname.split("/").filter(Boolean);
    if (parts[0] !== "cluster" || !parts[1]) return;
    const ctx = decodeURIComponent(parts[1]);
    setContext(ctx);
    k8s.setContext(ctx).catch(() => {
      /* non-fatal */
    });
  }, [focusedUrl, setContext]);

  return null;
}

/** Global keybindings — split / close pane / cycle focus / tab nav. */
function GlobalShortcuts() {
  const focusedUrl = useFocusedPaneUrl();
  const focusedId = usePanesStore((s) => s.focusedId);
  const { contextName } = useClusterStore();

  const goLogs = useCallback(() => {
    if (!contextName) return;
    navigateFocused(`/cluster/${encodeURIComponent(contextName)}/logs`);
  }, [contextName]);
  useShortcut("openLogs", goLogs);
  useShortcut("focusSearch", () => dispatchFocusSearch());

  const openNewTab = useCallback(() => {
    useTabsStore.getState().syncActiveUrl(focusedId, focusedUrl);
    useTabsStore.getState().openTab(focusedId, TABS_NEW_URL);
    navigateFocused(TABS_NEW_URL);
  }, [focusedId, focusedUrl]);
  useShortcut("newTab", openNewTab);

  const closeActiveTab = useCallback(() => {
    const pane = useTabsStore.getState().byPane[focusedId];
    if (!pane?.activeId) return;
    const nextId = useTabsStore.getState().closeTab(focusedId, pane.activeId);
    if (!nextId) return;
    const tab = useTabsStore.getState().byPane[focusedId]?.tabs.find(
      (t) => t.id === nextId,
    );
    if (tab) navigateFocused(tab.url);
  }, [focusedId]);
  useShortcut("closeTab", closeActiveTab);

  const jumpNext = useCallback(() => {
    useTabsStore.getState().next(focusedId);
    const pane = useTabsStore.getState().byPane[focusedId];
    const tab = pane?.tabs.find((t) => t.id === pane?.activeId);
    if (tab) navigateFocused(tab.url);
  }, [focusedId]);
  useShortcut("nextTab", jumpNext);

  const jumpPrev = useCallback(() => {
    useTabsStore.getState().prev(focusedId);
    const pane = useTabsStore.getState().byPane[focusedId];
    const tab = pane?.tabs.find((t) => t.id === pane?.activeId);
    if (tab) navigateFocused(tab.url);
  }, [focusedId]);
  useShortcut("prevTab", jumpPrev);

  const splitPane = useCallback(() => {
    usePanesStore.getState().splitPane();
  }, []);
  useShortcut("splitPane", splitPane);

  const closePane = useCallback(() => {
    const { focusedId: fid, panes } = usePanesStore.getState();
    if (panes.length <= 1) return;
    usePanesStore.getState().closePane(fid);
    useTabsStore.getState().removePane(fid);
  }, []);
  useShortcut("closePane", closePane);

  const focusNextPane = useCallback(() => {
    usePanesStore.getState().focusNext();
  }, []);
  useShortcut("focusNextPane", focusNextPane);

  const focusPrevPane = useCallback(() => {
    usePanesStore.getState().focusPrev();
  }, []);
  useShortcut("focusPrevPane", focusPrevPane);

  return <JumpTabShortcuts focusedId={focusedId} />;
}

/** Cmd+1..Cmd+9 → jump to the Nth tab in the focused pane. */
function JumpTabShortcuts({ focusedId }: { focusedId: string }) {
  const jumpToN = useCallback(
    (n: number) => () => {
      useTabsStore.getState().jumpToIndex(focusedId, n - 1);
      const pane = useTabsStore.getState().byPane[focusedId];
      const tab = pane?.tabs.find((t) => t.id === pane?.activeId);
      if (tab) navigateFocused(tab.url);
    },
    [focusedId],
  );
  useShortcut("jumpTab1", jumpToN(1));
  useShortcut("jumpTab2", jumpToN(2));
  useShortcut("jumpTab3", jumpToN(3));
  useShortcut("jumpTab4", jumpToN(4));
  useShortcut("jumpTab5", jumpToN(5));
  useShortcut("jumpTab6", jumpToN(6));
  useShortcut("jumpTab7", jumpToN(7));
  useShortcut("jumpTab8", jumpToN(8));
  useShortcut("jumpTab9", jumpToN(9));
  return null;
}

function Shell() {
  return (
    <>
      <Toaster richColors position="bottom-right" />
      <GlobalShortcuts />
      <FocusedPaneBrowserUrlBridge />
      <FocusedPaneClusterSyncer />
      <div className="flex h-screen flex-col bg-term-bg text-term-fg">
        <NavBar />
        <div className="flex-1 overflow-hidden">
          <SplitView />
        </div>
        <StatusBar />
        <ShellDock />
        <CommandPalette />
      </div>
    </>
  );
}

export default function App() {
  useEffect(() => {
    void checkForAppUpdate();
  }, []);

  return (
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>
  );
}
