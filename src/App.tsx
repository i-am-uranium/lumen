import { Suspense, lazy } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { CommandPalette } from "@/components/CommandPalette";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { ShellDock } from "@/components/shell/ShellDock";
import { k8s } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { Network, Sparkles } from "lucide-react";
import { useClusterStore } from "@/state/cluster";

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
const AiAssistant = lazy(() =>
  import("@/routes/cluster/AiAssistant").then(named("AiAssistant")),
);

const qc = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

function StatusBar() {
  const { pathname } = useLocation();
  const { contextName, namespace } = useClusterStore();
  const { data: ctxs = [] } = useQuery({
    queryKey: ["k8s", "contexts"],
    queryFn: k8s.listContexts,
    enabled: pathname.startsWith("/cluster"),
  });
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
        <span><kbd className="text-term-fg">Cmd K</kbd> search</span>
        <span><kbd className="text-term-fg">Cmd L</kbd> logs</span>
      </div>
    </div>
  );
}

function NavBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { contextName } = useClusterStore();
  const aiActive = pathname.endsWith("/ai");

  return (
    <nav className="flex items-center gap-2 px-4 py-2 border-b border-term-border-soft bg-term-panel">
      <span className="mds-heading text-[19px] text-term-fg">lumen</span>
      <span className="rounded-[4px] border border-term-green/40 bg-term-green/10 px-2 py-1 text-[11px] uppercase tracking-wide text-term-green">
        cluster
      </span>
      <div className="flex-1" />
      <ThemeSwitcher />
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
  );
}

function Shell() {
  return (
    <BrowserRouter>
      <Toaster richColors position="bottom-right" />
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
                <Route path="events" element={<EventsView />} />
                <Route path="map" element={<CloudMap />} />
                <Route path="nodes" element={<NodesView />} />
                <Route path="security" element={<SecurityView />} />
                <Route path="crds" element={<CrdBrowser />} />
                <Route path="helm" element={<HelmBrowser />} />
                <Route path="access" element={<TeamAccess />} />
                <Route path="logs" element={<LogsTab />} />
                <Route path="ai" element={<AiAssistant />} />
              </Route>
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
  return (
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>
  );
}
