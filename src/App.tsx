import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { CommandPalette } from "@/components/CommandPalette";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { ActivityDrawer } from "@/components/ActivityDrawer";
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
import { Bell, Lock, Network, Sparkles } from "lucide-react";
import { useClusterStore } from "@/state/cluster";
import { useShortcut } from "@/lib/shortcuts";
import { dispatchFocusSearch } from "@/lib/focusSearch";
import { checkForAppUpdate } from "@/lib/autoUpdater";
import { APP_VERSION } from "@/lib/appInfo";

const named =
  <T extends Record<string, unknown>>(key: keyof T) =>
  (m: T) => ({ default: m[key] as unknown as React.ComponentType<any> });

const FleetView = lazy(() =>
  import("@/routes/cluster/FleetView").then(named("FleetView")),
);
const ClusterWorkspace = lazy(() =>
  import("@/routes/cluster/ClusterWorkspace").then(named("ClusterWorkspace")),
);
const CloudMap = lazy(() =>
  import("@/routes/cluster/CloudMap").then(named("CloudMap")),
);
const SecurityView = lazy(() =>
  import("@/routes/cluster/SecurityView").then(named("SecurityView")),
);
const NetworkDebuggerView = lazy(() =>
  import("@/routes/cluster/NetworkDebuggerView").then(named("NetworkDebuggerView")),
);
const NodesView = lazy(() =>
  import("@/routes/cluster/NodesView").then(named("NodesView")),
);
const CrdBrowser = lazy(() =>
  import("@/routes/cluster/CrdBrowser").then(named("CrdBrowser")),
);
const TeamAccess = lazy(() =>
  import("@/routes/cluster/TeamAccess").then(named("TeamAccess")),
);
const LogsTab = lazy(() =>
  import("@/routes/cluster/LogsTab").then(named("LogsTab")),
);
const HelmBrowser = lazy(() =>
  import("@/routes/cluster/HelmBrowser").then(named("HelmBrowser")),
);
const Overview = lazy(() =>
  import("@/routes/cluster/Overview").then(named("Overview")),
);
const WorkloadsView = lazy(() =>
  import("@/routes/cluster/WorkloadsView").then(named("WorkloadsView")),
);
const NamespacesView = lazy(() =>
  import("@/routes/cluster/NamespacesView").then(named("NamespacesView")),
);
const EventsView = lazy(() =>
  import("@/routes/cluster/EventsView").then(named("EventsView")),
);
const TriageView = lazy(() =>
  import("@/routes/cluster/TriageView").then(named("TriageView")),
);
const RolloutTimelineView = lazy(() =>
  import("@/routes/cluster/RolloutTimelineView").then(named("RolloutTimelineView")),
);
const AiAssistant = lazy(() =>
  import("@/routes/cluster/AiAssistant").then(named("AiAssistant")),
);
const Settings = lazy(() =>
  import("@/routes/Settings").then(named("Settings")),
);
const ArgocdView = lazy(() =>
  import("@/routes/cluster/ArgocdView").then(named("ArgocdView")),
);
const TektonView = lazy(() =>
  import("@/routes/cluster/TektonView").then(named("TektonView")),
);
const NetworkPolicyWizard = lazy(() =>
  import("@/routes/cluster/wizards/NetworkPolicyWizard").then(
    named("NetworkPolicyWizard"),
  ),
);
const RbacBindingWizard = lazy(() =>
  import("@/routes/cluster/wizards/RbacBindingWizard").then(
    named("RbacBindingWizard"),
  ),
);
const HelmInstallWizard = lazy(() =>
  import("@/routes/cluster/wizards/HelmInstallWizard").then(
    named("HelmInstallWizard"),
  ),
);
const HelmUpgradeWizard = lazy(() =>
  import("@/routes/cluster/wizards/HelmInstallWizard").then(
    named("HelmUpgradeWizard"),
  ),
);

const qc = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

function StatusBar() {
  const { pathname } = useLocation();
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
      </div>
    </div>
  );
}

/**
 * Tiny topbar chip that appears only when read-only mode is active, so
 * it never adds visual weight in normal use. Click toggles the setting —
 * faster than going through Cmd-K for users who flip it often.
 */
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
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const queryClient = useQueryClient();
  const { contextName, setContext } = useClusterStore();
  const aiActive = pathname.endsWith("/ai");
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

  // Keep the cluster activity stream in sync with the active context.
  // Idempotent: store.start() short-circuits when already streaming the same
  // context. Tearing down on unmount keeps the channel from leaking when the
  // app navigates away from a cluster.
  useEffect(() => {
    if (contextName) {
      void startActivity(contextName);
    } else if (activeStreamCtx) {
      void stopActivity();
    }
  }, [contextName, activeStreamCtx, startActivity, stopActivity]);

  const switchContext = useCallback(
    async (nextContext: string) => {
      if (!contextName) return;
      try {
        await k8s.setContext(nextContext);
        setContext(nextContext);
        navigate(clusterSwitchPath(pathname, search, contextName, nextContext));
        await queryClient.invalidateQueries({ queryKey: ["k8s", "contexts"] });
        await queryClient.invalidateQueries({ queryKey: ["k8s", "namespaces"] });
      } catch (error) {
        toast.error((error as Error).message ?? String(error));
        throw error;
      }
    },
    [contextName, navigate, pathname, queryClient, search, setContext],
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
        <button
          type="button"
          disabled={!contextName}
          title={contextName ? "Open AI assistant (Cmd K, type ai)" : "Select a cluster context first"}
          onClick={() => contextName && navigate(`/cluster/${encodeURIComponent(contextName)}/ai`)}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-[6px] border px-3 text-[12px] font-medium transition-colors",
            aiActive
              ? "border-accent-primary/50 bg-accent-primary-soft text-accent-primary"
              : "border-term-border-soft bg-term-bg/70 text-term-muted hover:border-accent-primary/35 hover:text-term-fg",
            !contextName && "cursor-not-allowed opacity-45 hover:border-term-border-soft hover:text-term-muted",
          )}
        >
          <Sparkles className="size-3.5" aria-hidden="true" />
          <span>AI</span>
        </button>
      </nav>
      <ActivityDrawer open={activityOpen} onClose={() => setActivityOpen(false)} />
    </>
  );
}

/**
 * Registers global app-level keybindings that need router context.
 * Mounted once inside <BrowserRouter>. Drawer / per-view chords are
 * registered closer to where they fire — this component only owns
 * shortcuts that should work from anywhere.
 */
function GlobalShortcuts() {
  const navigate = useNavigate();
  const { contextName } = useClusterStore();
  const goLogs = useCallback(() => {
    if (!contextName) return;
    navigate(`/cluster/${encodeURIComponent(contextName)}/logs`);
  }, [contextName, navigate]);
  useShortcut("openLogs", goLogs);
  useShortcut("focusSearch", () => dispatchFocusSearch());
  return null;
}

function Shell() {
  return (
    <BrowserRouter>
      <Toaster richColors position="bottom-right" />
      <GlobalShortcuts />
      <div className="flex h-screen flex-col bg-term-bg text-term-fg">
        <NavBar />
        <div className="flex-1 overflow-hidden">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-[12px] text-term-muted">
                <span className="animate-pulse">loading...</span>
              </div>
            }
          >
            <Routes>
              <Route path="/" element={<Navigate to="/cluster" replace />} />
              <Route path="/cluster" element={<FleetView />} />
              <Route path="/cluster/:ctx" element={<ClusterWorkspace />}>
                <Route index element={<Navigate to="workloads" replace />} />
                <Route path="overview" element={<Overview />} />
                <Route path="workloads" element={<WorkloadsView />} />
                <Route path="workloads/:kind" element={<WorkloadsView />} />
                <Route path="namespaces" element={<NamespacesView />} />
                <Route path="triage" element={<TriageView />} />
                <Route path="events" element={<EventsView />} />
                <Route path="timeline" element={<RolloutTimelineView />} />
                <Route path="map" element={<CloudMap />} />
                <Route path="nodes" element={<NodesView />} />
                <Route path="security" element={<SecurityView />} />
                <Route path="network-debugger" element={<NetworkDebuggerView />} />
                <Route path="crds" element={<CrdBrowser />} />
                <Route path="helm" element={<HelmBrowser />} />
                <Route path="access" element={<TeamAccess />} />
                <Route path="logs" element={<LogsTab />} />
                <Route path="ai" element={<AiAssistant />} />
                <Route path="argocd" element={<ArgocdView />} />
                <Route path="tekton" element={<TektonView />} />
                <Route
                  path="wizards/network-policy"
                  element={<NetworkPolicyWizard />}
                />
                <Route
                  path="wizards/rbac-binding"
                  element={<RbacBindingWizard />}
                />
                <Route
                  path="helm/install"
                  element={<HelmInstallWizard />}
                />
                <Route
                  path="helm/upgrade/:release"
                  element={<HelmUpgradeWizard />}
                />
              </Route>
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/cluster" replace />} />
            </Routes>
          </Suspense>
        </div>
        <StatusBar />
        <ShellDock />
        <CommandPalette />
      </div>
    </BrowserRouter>
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
