import { Suspense, lazy, useEffect, useRef } from "react";
import {
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { cn } from "@/lib/utils";
import { PaneProvider } from "@/components/PaneContext";
import { TabBar, TabsSyncer } from "@/components/TabBar";
import { usePanesStore } from "@/state/panes";

// Lazy route components — same imports as App.tsx used pre-split,
// duplicated here so PaneShell owns its own routes tree. Each pane
// gets its own MemoryRouter instance, so React mounts these per-pane.
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
const MetricsExplorerView = lazy(() =>
  import("@/routes/cluster/MetricsExplorerView").then(named("MetricsExplorerView")),
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
const ClusterCompareView = lazy(() =>
  import("@/routes/cluster/ClusterCompareView").then(named("ClusterCompareView")),
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
const AlertInboxView = lazy(() =>
  import("@/routes/cluster/AlertInboxView").then(named("AlertInboxView")),
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
const WorkspacesView = lazy(() =>
  import("@/routes/cluster/WorkspacesView").then(named("WorkspacesView")),
);
const ChangeHistoryView = lazy(() =>
  import("@/routes/cluster/ChangeHistoryView").then(named("ChangeHistoryView")),
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

function PaneRoutes() {
  return (
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
          <Route path="compare" element={<ClusterCompareView />} />
          <Route path="namespaces" element={<NamespacesView />} />
          <Route path="triage" element={<TriageView />} />
          <Route path="alerts" element={<AlertInboxView />} />
          <Route path="events" element={<EventsView />} />
          <Route path="timeline" element={<RolloutTimelineView />} />
          <Route path="map" element={<CloudMap />} />
          <Route path="nodes" element={<NodesView />} />
          <Route path="metrics" element={<MetricsExplorerView />} />
          <Route path="security" element={<SecurityView />} />
          <Route path="network-debugger" element={<NetworkDebuggerView />} />
          <Route path="crds" element={<CrdBrowser />} />
          <Route path="helm" element={<HelmBrowser />} />
          <Route path="access" element={<TeamAccess />} />
          <Route path="logs" element={<LogsTab />} />
          <Route path="ai" element={<AiAssistant />} />
          <Route path="argocd" element={<ArgocdView />} />
          <Route path="tekton" element={<TektonView />} />
          <Route path="workspaces" element={<WorkspacesView />} />
          <Route path="change-history" element={<ChangeHistoryView />} />
          <Route path="wizards/network-policy" element={<NetworkPolicyWizard />} />
          <Route path="wizards/rbac-binding" element={<RbacBindingWizard />} />
          <Route path="helm/install" element={<HelmInstallWizard />} />
          <Route path="helm/upgrade/:release" element={<HelmUpgradeWizard />} />
        </Route>
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/cluster" replace />} />
      </Routes>
    </Suspense>
  );
}

/**
 * Bridge between this pane's MemoryRouter and the panes store.
 *
 * - Whenever the MemoryRouter location changes (user clicked something
 *   inside the pane), write it to `panesStore.panes[paneId].url`.
 * - Whenever the store URL changes from outside (chrome called
 *   `setPaneUrl` from NavBar / CommandPalette / a shortcut), pull it
 *   into the MemoryRouter via `navigate(url)`.
 *
 * The two effects are idempotent — both compare against the current
 * value before writing — so they don't ping-pong each other.
 */
function PaneLocationBridge({ paneId }: { paneId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const storeUrl = usePanesStore(
    (s) => s.panes.find((p) => p.id === paneId)?.url ?? "/",
  );

  const innerUrl = location.pathname + location.search;
  // Track the innerUrl value the last time we synced. Initial value is
  // the mount-time inner location — so the very first effect run sees
  // "innerUrl hasn't changed since seed" and skips writing to the
  // store, which avoids clobbering any concurrent store-side update
  // (deep-link adoption, chrome navigation, the +-button's openTab
  // flow). This invariant survives StrictMode's double-invocation:
  // the ref persists across the dev-time setup→cleanup→setup cycle,
  // so the second effect run also short-circuits.
  const lastSyncedInnerRef = useRef(innerUrl);

  // inner → store
  useEffect(() => {
    if (lastSyncedInnerRef.current === innerUrl) return;
    lastSyncedInnerRef.current = innerUrl;
    const current = usePanesStore
      .getState()
      .panes.find((p) => p.id === paneId)?.url;
    if (current !== innerUrl) {
      usePanesStore.getState().setPaneUrl(paneId, innerUrl);
    }
  }, [paneId, innerUrl]);

  // store → inner (chrome-driven navigation)
  useEffect(() => {
    if (storeUrl !== innerUrl) {
      navigate(storeUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeUrl, navigate]);

  return null;
}

/**
 * One pane. Wraps the route tree in its own MemoryRouter so navigation
 * stays local, then mounts the TabBar and route Suspense boundary.
 *
 * Clicking anywhere inside the pane focuses it — matches a window
 * manager's "click-to-focus" convention and ensures the global cluster
 * store always reflects the pane the user is actively touching.
 */
export function PaneShell({
  paneId,
  initialUrl,
  focused,
  showPaneChrome,
  onClose,
}: {
  paneId: string;
  initialUrl: string;
  focused: boolean;
  /** True when more than one pane is open — adds the focus outline + close button. */
  showPaneChrome: boolean;
  onClose: () => void;
}) {
  const handleFocus = () => usePanesStore.getState().focusPane(paneId);

  return (
    <div
      data-pane-id={paneId}
      onMouseDownCapture={handleFocus}
      className={cn(
        "flex h-full min-w-0 flex-col bg-term-bg text-term-fg",
        showPaneChrome &&
          (focused
            ? "ring-1 ring-inset ring-accent-primary/45"
            : "opacity-90"),
      )}
    >
      <MemoryRouter initialEntries={[initialUrl]}>
        <PaneProvider paneId={paneId}>
          <PaneLocationBridge paneId={paneId} />
          <TabsSyncer paneId={paneId} />
          {showPaneChrome && (
            <PaneHeader paneId={paneId} focused={focused} onClose={onClose} />
          )}
          <TabBar paneId={paneId} />
          <div className="flex-1 overflow-hidden">
            <PaneRoutes />
          </div>
        </PaneProvider>
      </MemoryRouter>
    </div>
  );
}

/**
 * Minimal pane header — only renders in multi-pane mode. Shows the
 * pane number, the active context, and a close button. Click the
 * header to focus.
 */
function PaneHeader({
  paneId,
  focused,
  onClose,
}: {
  paneId: string;
  focused: boolean;
  onClose: () => void;
}) {
  const index = usePanesStore(
    (s) => s.panes.findIndex((p) => p.id === paneId) + 1,
  );
  const url = usePanesStore(
    (s) => s.panes.find((p) => p.id === paneId)?.url ?? "",
  );
  const parts = url.split("?")[0].split("/").filter(Boolean);
  const ctx = parts[0] === "cluster" && parts[1] ? decodeURIComponent(parts[1]) : null;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-b border-term-border-soft px-2 py-1 text-[11px]",
        focused
          ? "bg-accent-primary-soft text-accent-primary"
          : "bg-term-panel text-term-muted",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-[3px] font-mono text-[10px]",
            focused ? "bg-accent-primary text-[var(--term-bg)]" : "bg-term-border-soft",
          )}
        >
          {index}
        </span>
        <span className="truncate font-mono">
          {ctx ? `pane · ${ctx}` : "pane"}
        </span>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close pane ${index}`}
        title="Close pane (Cmd+Shift+W)"
        className="inline-flex size-5 items-center justify-center rounded-[3px] text-term-muted transition-colors hover:bg-term-border-soft hover:text-term-fg"
      >
        ×
      </button>
    </div>
  );
}
