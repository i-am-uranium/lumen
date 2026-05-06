import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleStop,
  ExternalLink,
  GitBranch,
  History as HistoryIcon,
  Layers,
  Loader2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  ServerCog,
  ShieldQuestion,
  Sliders,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import {
  k8s,
  type ArgoApplicationResource,
  type ArgoApplicationSummary,
  type ArgoApplicationSetSummary,
  type ArgoAppProjectSummary,
  type ArgoHistoryEntry,
  type ArgoSyncOptions,
  type WorkloadKind,
} from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DataTableShell,
} from "@/components/ui/data-table";
import { LumenPage, PageHeader, SectionPanel } from "@/components/lumen/page";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { ResourceDetailDrawer } from "@/components/ResourceDetailDrawer";
import {
  ARGOCD_DETAIL_PANEL_WIDTH_MIN,
  type ArgocdResourceView,
  useUiSettings,
} from "@/state/uiSettings";
import { groupResourcesByKind } from "./argocdResourceTree";
import {
  buildOwnerTree,
  flattenTree,
  type OwnerFact,
  type ResourceWithOwner,
} from "./argocdOwnerTree";

/** Upper bound on the detail panel width as a fraction of the viewport. */
const DETAIL_PANEL_MAX_VW_FRACTION = 0.75;
/** Step size in pixels for keyboard arrow nudges on the resize handle. */
const DETAIL_PANEL_KEYBOARD_STEP = 32;

function clampDetailWidth(width: number, viewportWidth: number): number {
  const max = Math.max(
    ARGOCD_DETAIL_PANEL_WIDTH_MIN,
    Math.floor(viewportWidth * DETAIL_PANEL_MAX_VW_FRACTION),
  );
  if (width < ARGOCD_DETAIL_PANEL_WIDTH_MIN) {
    return ARGOCD_DETAIL_PANEL_WIDTH_MIN;
  }
  if (width > max) return max;
  return width;
}

/**
 * ArgoCD Applications view.
 *
 * Master/detail layout with multi-select status filtering, a full sync
 * dialog (parity with `argocd app sync --help`), terminate-running-op
 * support, and rollback-from-history. Detection is gated by ClusterWorkspace
 * so this route only renders when the cluster has the Application CRD.
 *
 * Polling cadence: list 15s, detail 5s while a row is open. Both queries
 * key off context so the cache resets cleanly when the user switches
 * clusters.
 */
// ─── Per-resource deep-dive helpers ───────────────────────────────────────
//
// ArgoCD reports `destination.server` per Application. When that's the
// in-cluster URL, the K8s objects ArgoCD manages live in the same
// cluster Lumen is already talking to — so we can open them in the
// standard ResourceDetailDrawer for full CTAs (YAML / events / logs /
// scale / restart / delete / set-image).
//
// External destinations (ArgoCD managing remote clusters via its
// secret-based registration) are out of scope for this v1: Lumen would
// need to either find a matching kubeconfig context or proxy through
// ArgoCD's HTTP API. Both are reasonable follow-ups; for now we render
// a tooltip and keep the row non-clickable.
const IN_CLUSTER_SERVER_VALUES = new Set([
  "",
  "https://kubernetes.default.svc",
  "https://kubernetes.default.svc.cluster.local",
  "https://kubernetes.default",
]);

function isInClusterDestination(destinationServer: string | undefined): boolean {
  return IN_CLUSTER_SERVER_VALUES.has(destinationServer ?? "");
}

// ArgoCD reports `kind` capitalized (e.g. "Deployment"). Lumen's
// ResourceDetailDrawer matches against lowercased identifiers from the
// WorkloadKind enum. Lowercasing covers 95%+ of K8s kinds; a handful
// of compound names (PodDisruptionBudget → poddisruptionbudget) match
// because the enum strips word boundaries the same way.
function argocdKindToLumenKind(kind: string): string {
  return kind.toLowerCase();
}

const SYNC_STATUSES = ["Synced", "OutOfSync", "Unknown"] as const;
const HEALTH_STATUSES = [
  "Healthy",
  "Degraded",
  "Progressing",
  "Suspended",
  "Missing",
] as const;
type SyncStatus = (typeof SYNC_STATUSES)[number];
type HealthStatus = (typeof HEALTH_STATUSES)[number];

/**
 * Top-level tab identity for the ArgocdView. Persisted in the URL search
 * param `tab` so a deep-link / refresh / back-button restores the user's
 * last-viewed tab. Defaults to "applications" for backwards compatibility
 * with the original (untabbed) view.
 */
type ArgocdTab = "applications" | "applicationsets" | "appprojects";

const ARGOCD_TABS: ReadonlyArray<{ id: ArgocdTab; label: string }> = [
  { id: "applications", label: "Applications" },
  { id: "applicationsets", label: "ApplicationSets" },
  { id: "appprojects", label: "AppProjects" },
];

function parseTab(value: string | null): ArgocdTab {
  if (value === "applicationsets" || value === "appprojects") return value;
  return "applications";
}

export function ArgocdView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get("tab"));

  function setTab(next: ArgocdTab): void {
    const params = new URLSearchParams(searchParams);
    if (next === "applications") {
      params.delete("tab");
    } else {
      params.set("tab", next);
    }
    // Drop sub-selections when changing tab so the new view starts fresh
    // (an `app=...` selection from the Applications tab is meaningless on
    // the AppProjects tab).
    params.delete("app");
    params.delete("appset");
    params.delete("project");
    setSearchParams(params, { replace: true });
  }

  return (
    <LumenPage>
      <ArgocdTabStrip active={tab} onChange={setTab} />
      {tab === "applications" && <ApplicationsTab context={context} />}
      {tab === "applicationsets" && <ApplicationSetsTab context={context} />}
      {tab === "appprojects" && <AppProjectsTab context={context} />}
    </LumenPage>
  );
}

/**
 * Top-of-page tab strip. Three buttons, ARIA-tab semantics, current tab
 * highlighted with the same accent treatment as ViewModeToggle so the
 * page reads as one cohesive surface.
 */
function ArgocdTabStrip({
  active,
  onChange,
}: {
  active: ArgocdTab;
  onChange: (next: ArgocdTab) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="argocd resource type"
      className="-mt-2 mb-1 flex items-center gap-1 border-b border-border-subtle"
    >
      {ARGOCD_TABS.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className={cn(
              "relative -mb-px px-3 py-2 text-[12px] transition-colors",
              isActive
                ? "border-b-2 border-accent-primary text-text-primary"
                : "border-b-2 border-transparent text-text-muted hover:text-text-primary",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The original Applications view, factored out of the component that's
 * now the routing entry point. Behavior is unchanged — same filter
 * strip, master/detail split, polling cadence, and per-resource CTAs.
 * The only difference vs PR #42's shape is that this component owns
 * its own LumenPage children rather than the page wrapper itself.
 */
function ApplicationsTab({ context }: { context: string }) {
  const qc = useQueryClient();
  const readOnly = useUiSettings((s) => s.readOnly);

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedKey = searchParams.get("app") ?? null;
  const [filter, setFilter] = useState("");
  const [syncFilter, setSyncFilter] = useState<Set<SyncStatus>>(new Set());
  const [healthFilter, setHealthFilter] = useState<Set<HealthStatus>>(
    new Set(),
  );
  const [projectFilter, setProjectFilter] = useState<string>("");

  const apps = useQuery({
    queryKey: ["argocd", "apps", context],
    queryFn: () => k8s.listArgocdApplications(context || undefined),
    staleTime: 5_000,
    refetchInterval: 15_000,
  });

  const projects = useMemo(() => {
    const set = new Set<string>();
    for (const a of apps.data ?? []) set.add(a.project);
    return Array.from(set).sort();
  }, [apps.data]);

  const filteredApps = useMemo(() => {
    let list = apps.data ?? [];
    if (filter.trim()) {
      const f = filter.toLowerCase();
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(f) ||
          a.namespace.toLowerCase().includes(f) ||
          a.project.toLowerCase().includes(f) ||
          a.repo_url.toLowerCase().includes(f),
      );
    }
    if (syncFilter.size > 0) {
      list = list.filter((a) => syncFilter.has(a.sync_status as SyncStatus));
    }
    if (healthFilter.size > 0) {
      list = list.filter((a) =>
        healthFilter.has(a.health_status as HealthStatus),
      );
    }
    if (projectFilter) {
      list = list.filter((a) => a.project === projectFilter);
    }
    return list;
  }, [apps.data, filter, syncFilter, healthFilter, projectFilter]);

  // Counts per status, computed off the unfiltered list so chips show
  // "how many would I see" rather than "how many are visible right now".
  const counts = useMemo(() => {
    const sync = new Map<string, number>();
    const health = new Map<string, number>();
    for (const a of apps.data ?? []) {
      sync.set(a.sync_status, (sync.get(a.sync_status) ?? 0) + 1);
      health.set(a.health_status, (health.get(a.health_status) ?? 0) + 1);
    }
    return { sync, health };
  }, [apps.data]);

  const selected = useMemo(() => {
    if (!selectedKey) return null;
    return (apps.data ?? []).find(
      (a) => `${a.namespace}/${a.name}` === selectedKey,
    );
  }, [apps.data, selectedKey]);

  function selectApp(app: ArgoApplicationSummary | null) {
    const next = new URLSearchParams(searchParams);
    if (app) {
      next.set("app", `${app.namespace}/${app.name}`);
    } else {
      next.delete("app");
    }
    setSearchParams(next, { replace: true });
  }

  const totalActiveFilters =
    syncFilter.size +
    healthFilter.size +
    (projectFilter ? 1 : 0) +
    (filter.trim() ? 1 : 0);

  return (
    <>
      <PageHeader
        eyebrow="argocd"
        title="Applications"
        description="GitOps state of every ArgoCD Application reachable in this cluster. Sync / refresh / rollback actions write directly to the CRD."
        icon={<ServerCog className="size-4" />}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => apps.refetch()}
            disabled={apps.isFetching}
          >
            <RefreshCw
              className={cn("size-3.5", apps.isFetching && "animate-spin")}
            />
            refresh list
          </Button>
        }
      />

      {/* ── Filter strip ───────────────────────────────────────────────── */}
      <SectionPanel className="py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter by name / namespace / repo"
            className="h-8 w-72"
          />
          <FilterChipGroup
            label="sync"
            options={SYNC_STATUSES}
            selected={syncFilter}
            counts={counts.sync}
            onToggle={(v) => setSyncFilter((prev) => toggleSet(prev, v))}
          />
          <FilterChipGroup
            label="health"
            options={HEALTH_STATUSES}
            selected={healthFilter}
            counts={counts.health}
            onToggle={(v) => setHealthFilter((prev) => toggleSet(prev, v))}
          />
          {projects.length > 1 && (
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="h-8 rounded-control border border-border-default bg-elevated px-2 text-[11px] text-text-primary"
              title="filter by project"
            >
              <option value="">project: any</option>
              {projects.map((p) => (
                <option key={p} value={p}>
                  project: {p}
                </option>
              ))}
            </select>
          )}
          {totalActiveFilters > 0 && (
            <button
              type="button"
              onClick={() => {
                setFilter("");
                setSyncFilter(new Set());
                setHealthFilter(new Set());
                setProjectFilter("");
              }}
              className="text-[11px] text-text-muted hover:text-text-primary"
            >
              clear filters
            </button>
          )}
          <span className="ml-auto text-[11px] text-text-muted tabular-nums">
            {filteredApps.length} of {apps.data?.length ?? 0}
          </span>
        </div>
      </SectionPanel>

      {apps.error ? (
        <SectionPanel className="border border-danger/30 bg-[var(--status-error-soft)]">
          <p className="text-[12px] text-danger">
            {(apps.error as Error).message ?? "failed to fetch applications"}
          </p>
        </SectionPanel>
      ) : apps.isLoading ? (
        <SectionPanel>
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            <Loader2 className="size-3.5 animate-spin" /> loading applications…
          </div>
        </SectionPanel>
      ) : (apps.data ?? []).length === 0 ? (
        <SectionPanel>
          <p className="text-[12px] text-text-muted">
            No Applications found in this cluster. ArgoCD CRDs are registered
            but no instances exist yet.
          </p>
        </SectionPanel>
      ) : (
        <MasterDetailSplit
          master={
          <SectionPanel className="overflow-hidden p-0">
            <DataTableShell>
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <Th>name</Th>
                    <Th>namespace</Th>
                    <Th>project</Th>
                    <Th>sync</Th>
                    <Th>health</Th>
                    <Th>destination</Th>
                    <Th>resources</Th>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filteredApps.map((a) => {
                    const key = `${a.namespace}/${a.name}`;
                    const active = selectedKey === key;
                    return (
                      <DataTableRow
                        key={key}
                        onClick={() => selectApp(a)}
                        className={cn(
                          "cursor-pointer",
                          active && "bg-accent-primary-soft",
                        )}
                      >
                        <DataTableCell className="px-4">
                          <span className="text-[13px] font-medium text-text-primary">
                            {a.name}
                          </span>
                        </DataTableCell>
                        <DataTableCell mono className="text-[11px]">
                          {a.namespace}
                        </DataTableCell>
                        <DataTableCell mono className="text-[11px]">
                          {a.project}
                        </DataTableCell>
                        <DataTableCell>
                          <SyncPill status={a.sync_status} />
                        </DataTableCell>
                        <DataTableCell>
                          <HealthPill status={a.health_status} />
                        </DataTableCell>
                        <DataTableCell mono className="text-[11px] truncate">
                          {a.destination_namespace || "—"}
                        </DataTableCell>
                        <DataTableCell
                          mono
                          className="text-[11px] tabular-nums"
                        >
                          {a.resource_count}
                        </DataTableCell>
                      </DataTableRow>
                    );
                  })}
                </DataTableBody>
              </DataTable>
            </DataTableShell>
            {filteredApps.length === 0 && (
              <p className="px-4 py-3 text-[11px] text-text-muted">
                No applications match the current filters.
              </p>
            )}
          </SectionPanel>
          }
          detail={
            selected ? (
              <ApplicationDetailPanel
                context={context}
                app={selected}
                readOnly={readOnly}
                onClose={() => selectApp(null)}
                onMutated={() => {
                  qc.invalidateQueries({
                    queryKey: ["argocd", "apps", context],
                  });
                  qc.invalidateQueries({
                    queryKey: [
                      "argocd",
                      "app",
                      context,
                      selected.namespace,
                      selected.name,
                    ],
                  });
                }}
              />
            ) : (
              <SectionPanel>
                <p className="text-[12px] text-text-muted">
                  Select an application to see its sync state, managed
                  resources, and run actions.
                </p>
              </SectionPanel>
            )
          }
        />
      )}
    </>
  );
}

function toggleSet<T>(prev: Set<T>, value: T): Set<T> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * Master/detail split with a draggable divider.
 *
 * Layout: flex row on `lg+` viewports, stacked on small. The detail
 * column is rendered at a fixed pixel width (persisted via
 * `useUiSettings.argocdDetailPanelWidth`); the master flexes to fill
 * the remainder. A 4px-wide handle in between updates the width on
 * pointer drag and on left/right arrow nudges when focused.
 *
 * Why plain mouse events (no library): drag interactions are simple
 * enough that pulling in react-resizable-panels (or similar) buys us
 * nothing for one component, and the ArgoCD bundle PR would have to
 * deal with the new dependency. Listeners attach to `document` so the
 * drag tracks past the handle and across other elements.
 */
function MasterDetailSplit({
  master,
  detail,
}: {
  master: React.ReactNode;
  detail: React.ReactNode;
}) {
  const persistedWidth = useUiSettings((s) => s.argocdDetailPanelWidth);
  const setPersistedWidth = useUiSettings(
    (s) => s.setArgocdDetailPanelWidth,
  );

  // Track viewport width so we can clamp the upper bound (75% vw) on
  // both initial render and window resize. SSR-safe initial value.
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Local mirror of the width — updates at pointermove rate without
  // hammering localStorage. The persisted store is written on
  // pointerup (or after a keyboard nudge).
  const [width, setWidth] = useState<number>(() =>
    clampDetailWidth(persistedWidth, viewportWidth),
  );
  // Re-sync when the persisted value changes from outside (e.g. another
  // tab) or when the viewport shrinks past the current width.
  useLayoutEffect(() => {
    setWidth((prev) => {
      const target = clampDetailWidth(persistedWidth, viewportWidth);
      // If the live width is already in-bounds for the current viewport
      // and matches the persisted snapshot, leave it alone — avoids a
      // re-render loop during drag.
      if (prev === target) return prev;
      // During an active drag, prefer the in-flight value over the
      // persisted one so the cursor stays glued to the handle.
      if (draggingRef.current) {
        return clampDetailWidth(prev, viewportWidth);
      }
      return target;
    });
  }, [persistedWidth, viewportWidth]);

  const draggingRef = useRef(false);
  const handleRef = useRef<HTMLDivElement | null>(null);

  const persist = useCallback(
    (next: number) => {
      const clamped = clampDetailWidth(next, viewportWidth);
      setPersistedWidth(clamped);
    },
    [setPersistedWidth, viewportWidth],
  );

  const onPointerDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      draggingRef.current = true;
      // Save current selection styles so we can restore. Disabling
      // user-select on <body> prevents accidental text selection while
      // the user drags across other content.
      const previousUserSelect = document.body.style.userSelect;
      const previousCursor = document.body.style.cursor;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const startX = e.clientX;
      const startWidth = width;

      const onMove = (ev: MouseEvent) => {
        // The handle sits to the LEFT of the detail panel, so dragging
        // right shrinks the detail (negative delta widens master). We
        // want dragging right → wider master → narrower detail; the
        // user expectation is that dragging the handle towards the
        // detail panel makes detail smaller.
        const delta = startX - ev.clientX;
        const next = clampDetailWidth(startWidth + delta, viewportWidth);
        setWidth(next);
      };

      const onUp = () => {
        draggingRef.current = false;
        document.body.style.userSelect = previousUserSelect;
        document.body.style.cursor = previousCursor;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        // Persist whatever we ended on — read straight off the closure
        // by using the latest setter callback to grab final state.
        setWidth((finalWidth) => {
          persist(finalWidth);
          return finalWidth;
        });
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [width, viewportWidth, persist],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      // ArrowRight shrinks the detail panel (handle moves right →
      // detail narrows); ArrowLeft widens it. Mirrors the pointer
      // semantics above.
      const delta =
        e.key === "ArrowRight"
          ? -DETAIL_PANEL_KEYBOARD_STEP
          : DETAIL_PANEL_KEYBOARD_STEP;
      setWidth((prev) => {
        const next = clampDetailWidth(prev + delta, viewportWidth);
        persist(next);
        return next;
      });
    },
    [viewportWidth, persist],
  );

  // Below the lg breakpoint we stack vertically and hide the handle —
  // drag-resize on a touch screen is a different UX problem.
  const stacked = viewportWidth < 1024;
  const clampedWidth = clampDetailWidth(width, viewportWidth);
  const maxWidth = Math.max(
    ARGOCD_DETAIL_PANEL_WIDTH_MIN,
    Math.floor(viewportWidth * DETAIL_PANEL_MAX_VW_FRACTION),
  );

  if (stacked) {
    return (
      <div className="flex flex-col gap-4">
        <div>{master}</div>
        <div>{detail}</div>
      </div>
    );
  }

  return (
    <div className="flex gap-0">
      <div className="min-w-0 flex-1">{master}</div>
      <div
        ref={handleRef}
        role="separator"
        aria-label="resize detail panel"
        aria-orientation="vertical"
        aria-valuemin={ARGOCD_DETAIL_PANEL_WIDTH_MIN}
        aria-valuemax={maxWidth}
        aria-valuenow={clampedWidth}
        tabIndex={0}
        onMouseDown={onPointerDown}
        onKeyDown={onKeyDown}
        className={cn(
          "group relative mx-1 w-1 shrink-0 cursor-col-resize rounded-full bg-border-subtle/60 transition-colors",
          "hover:bg-accent-primary/40 focus-visible:bg-accent-primary/60 focus-visible:outline-none",
        )}
        title="drag to resize · ←/→ to nudge"
      >
        {/* Wider invisible hit-target for easier grabbing. */}
        <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
      </div>
      <div style={{ width: clampedWidth }} className="shrink-0">
        {detail}
      </div>
    </div>
  );
}

function ApplicationDetailPanel({
  context,
  app,
  readOnly,
  onClose,
  onMutated,
}: {
  context: string;
  app: ArgoApplicationSummary;
  readOnly: boolean;
  onClose: () => void;
  onMutated: () => void;
}) {
  const detail = useQuery({
    queryKey: ["argocd", "app", context, app.namespace, app.name],
    queryFn: () =>
      k8s.getArgocdApplication(context || undefined, app.namespace, app.name),
    staleTime: 1_000,
    refetchInterval: 5_000,
  });
  const [busyAction, setBusyAction] = useState<
    null | "sync" | "refresh-soft" | "refresh-hard" | "terminate" | "rollback"
  >(null);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [terminateConfirm, setTerminateConfirm] = useState(false);
  const [pendingRollback, setPendingRollback] =
    useState<ArgoHistoryEntry | null>(null);
  // Selected managed-resource: opens Lumen's ResourceDetailDrawer for the
  // underlying K8s object so users get full per-resource CTAs (YAML, events,
  // logs, scale, restart, delete, set-image) without leaving Lumen.
  const [drawerResource, setDrawerResource] = useState<{
    kind: string;
    namespace: string;
    name: string;
  } | null>(null);
  // Per-resource sync — visually distinct from the app-level sync busy state
  // so the two can run independently if needed.
  const [perResourceSyncBusy, setPerResourceSyncBusy] = useState<string | null>(
    null,
  );
  // Per-app managed-resource filter. Resets when the user navigates
  // between Applications — the filter is meaningful for the resource
  // list of *this* app and stale text would just be confusing.
  const [resourceFilterText, setResourceFilterText] = useState("");
  const resourceSearchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setResourceFilterText("");
  }, [app.namespace, app.name]);
  // Global "/" shortcut: focus the resource search when the detail
  // panel is mounted. Skip when the user is already typing somewhere
  // else (input/textarea/contenteditable) so we don't hijack their
  // keystrokes.
  useEffect(() => {
    function isTypingTarget(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const node = resourceSearchRef.current;
      if (!node) return;
      e.preventDefault();
      node.focus();
      node.select();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const lockedTitle = readOnly ? " (read-only mode)" : "";
  const operationRunning = detail.data?.operation_state?.phase === "Running";
  const inCluster = isInClusterDestination(app.destination_server);

  async function performSync(options: ArgoSyncOptions) {
    setBusyAction("sync");
    try {
      await k8s.syncArgocdApplication(
        context || undefined,
        app.namespace,
        app.name,
        options,
      );
      toast.success(
        options.dryRun
          ? "dry-run sync requested"
          : `sync requested for ${app.name}`,
      );
      onMutated();
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function performRefresh(hard: boolean) {
    setBusyAction(hard ? "refresh-hard" : "refresh-soft");
    try {
      await k8s.refreshArgocdApplication(
        context || undefined,
        app.namespace,
        app.name,
        hard,
      );
      toast.success(hard ? "hard refresh requested" : "refresh requested");
      onMutated();
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setBusyAction(null);
    }
  }

  /**
   * Sync a single managed resource — translates to a normal sync with the
   * `resources` array narrowed to one entry. ArgoCD's controller honors
   * the subset and skips everything else.
   */
  async function performSyncResource(r: ArgoApplicationResource) {
    const key = resourceKey(r);
    setPerResourceSyncBusy(key);
    try {
      await k8s.syncArgocdApplication(
        context || undefined,
        app.namespace,
        app.name,
        {
          resources: [
            {
              group: r.group,
              kind: r.kind,
              name: r.name,
              namespace: r.namespace ?? undefined,
            },
          ],
        },
      );
      toast.success(`sync requested for ${r.kind}/${r.name}`);
      onMutated();
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setPerResourceSyncBusy(null);
    }
  }

  async function performTerminate() {
    setBusyAction("terminate");
    try {
      await k8s.terminateArgocdOperation(
        context || undefined,
        app.namespace,
        app.name,
      );
      toast.success("operation termination requested");
      onMutated();
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setBusyAction(null);
      setTerminateConfirm(false);
    }
  }

  async function performRollback(entry: ArgoHistoryEntry) {
    setBusyAction("rollback");
    try {
      // Rollback is just a sync with the historical revision pinned and
      // prune enabled — same semantics as `argocd app rollback`.
      await k8s.syncArgocdApplication(
        context || undefined,
        app.namespace,
        app.name,
        { revision: entry.revision, prune: true },
      );
      toast.success(`rollback to ${entry.revision.slice(0, 7)} requested`);
      onMutated();
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setBusyAction(null);
      setPendingRollback(null);
    }
  }

  return (
    <>
    <SectionPanel className="self-start">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="mds-heading text-[14px] text-text-primary truncate">
            {app.name}
          </h2>
          <p className="font-mono text-[11px] text-text-muted">
            {app.namespace} · {app.project}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-text-muted hover:bg-elevated hover:text-text-primary"
          aria-label="close"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SyncPill status={app.sync_status} />
        <HealthPill status={app.health_status} />
        {detail.data?.auto_sync && (
          <span className="rounded border border-info/40 bg-info-soft px-1.5 py-0.5 font-mono text-[10px] text-info">
            auto-sync{detail.data?.self_heal ? " + heal" : ""}
          </span>
        )}
        {operationRunning && (
          <span className="inline-flex items-center gap-1 rounded border border-info/40 bg-info-soft px-1.5 py-0.5 font-mono text-[10px] text-info">
            <Loader2 className="size-2.5 animate-spin" />
            running
          </span>
        )}
      </div>

      <div className="mb-4 grid grid-cols-1 gap-1.5 text-[11px]">
        <DetailRow
          label="repo"
          value={app.repo_url || "—"}
          icon={<GitBranch className="size-3" />}
        />
        <DetailRow label="path" value={app.path || "—"} />
        <DetailRow label="revision" value={app.target_revision || "HEAD"} />
        <DetailRow
          label="destination"
          value={`${app.destination_namespace || "—"} @ ${
            app.destination_server || "in-cluster"
          }`}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => setSyncDialogOpen(true)}
          disabled={busyAction === "sync" || readOnly}
          title={`sync${lockedTitle}`}
        >
          {busyAction === "sync" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
          sync…
        </Button>
        <RefreshDropdown
          onSoft={() => void performRefresh(false)}
          onHard={() => void performRefresh(true)}
          softBusy={busyAction === "refresh-soft"}
          hardBusy={busyAction === "refresh-hard"}
          disabled={readOnly}
          lockedTitle={lockedTitle}
        />
        {operationRunning && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setTerminateConfirm(true)}
            disabled={busyAction === "terminate" || readOnly}
            title={`terminate running sync${lockedTitle}`}
          >
            {busyAction === "terminate" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CircleStop className="size-3.5" />
            )}
            terminate
          </Button>
        )}
      </div>

      {detail.data?.operation_state && (
        <div className="mb-4 rounded border border-border-subtle bg-elevated p-2">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">
            last operation
          </div>
          <div className="mt-1 text-[12px] text-text-primary">
            {detail.data.operation_state.phase ?? "—"}
            {detail.data.operation_state.revision && (
              <span className="ml-1 font-mono text-[10px] text-text-muted">
                @ {detail.data.operation_state.revision.slice(0, 7)}
              </span>
            )}
          </div>
          {detail.data.operation_state.message && (
            <div className="mt-0.5 text-[11px] text-text-muted">
              {detail.data.operation_state.message}
            </div>
          )}
        </div>
      )}

      <ManagedResourcesSection
        context={context}
        loading={detail.isLoading}
        resources={detail.data?.resources}
        inCluster={inCluster}
        readOnly={readOnly}
        syncBusyKey={perResourceSyncBusy}
        onOpen={(r) => setDrawerResource(toDrawerResource(r))}
        onSync={(r) => void performSyncResource(r)}
        filterText={resourceFilterText}
        onFilterChange={setResourceFilterText}
        searchInputRef={resourceSearchRef}
      />

      {detail.data?.history && detail.data.history.length > 0 && (
        <HistoryList
          history={detail.data.history}
          onRollback={(entry) => setPendingRollback(entry)}
          disabled={readOnly}
          lockedTitle={lockedTitle}
        />
      )}

      {syncDialogOpen && (
        <SyncDialog
          app={app}
          defaultRevision={app.target_revision || "HEAD"}
          managedResources={detail.data?.resources ?? []}
          busy={busyAction === "sync"}
          onCancel={() => setSyncDialogOpen(false)}
          onSubmit={(opts) => {
            setSyncDialogOpen(false);
            void performSync(opts);
          }}
        />
      )}

      <ConfirmActionDialog
        open={terminateConfirm}
        title="terminate running sync"
        description={`This clears the .operation field on ${app.name} — ArgoCD treats that as a terminate signal. Resources that have already started reconciling won't be rolled back; only the in-flight orchestration stops.`}
        target={`${app.namespace}/${app.name}`}
        confirmLabel="terminate"
        intent="warning"
        busy={busyAction === "terminate"}
        onCancel={() => setTerminateConfirm(false)}
        onConfirm={performTerminate}
      />

      <ConfirmActionDialog
        open={!!pendingRollback}
        title="rollback to historical revision"
        description={
          pendingRollback
            ? `This will sync ${app.name} back to ${pendingRollback.revision.slice(0, 7)} with prune enabled. Resources added since that revision will be deleted from the cluster.`
            : ""
        }
        target={`${app.namespace}/${app.name}`}
        confirmLabel="rollback"
        intent="warning"
        busy={busyAction === "rollback"}
        onCancel={() => setPendingRollback(null)}
        onConfirm={() => {
          if (pendingRollback) void performRollback(pendingRollback);
        }}
      />
    </SectionPanel>
    {/*
      Per-resource drawer — opens when a managed-resource row is clicked.
      Lumen's standard drawer fronts the YAML / events / logs / scale /
      restart / delete / set-image CTAs for the underlying K8s object.
      Mounted at panel level (not under SectionPanel) so the slide-in
      overlay isn't constrained by the panel's box.
    */}
    <ResourceDetailDrawer
      ctx={context}
      resource={drawerResource}
      onClose={() => setDrawerResource(null)}
    />
    </>
  );
}

// ─── Filter chips ─────────────────────────────────────────────────────────

function FilterChipGroup<T extends string>({
  label,
  options,
  selected,
  counts,
  onToggle,
}: {
  label: string;
  options: readonly T[];
  selected: Set<T>;
  counts: Map<string, number>;
  onToggle: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] uppercase tracking-wide text-text-muted">
        {label}
      </span>
      {options.map((opt) => {
        const active = selected.has(opt);
        const count = counts.get(opt) ?? 0;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onToggle(opt)}
            disabled={count === 0 && !active}
            className={cn(
              "rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
              active
                ? "border-accent-primary bg-accent-primary-soft text-accent-primary"
                : "border-border-default bg-surface text-text-secondary hover:bg-hover",
              count === 0 && !active && "opacity-40",
            )}
            title={`${count} ${opt}`}
          >
            {opt}
            {count > 0 && (
              <span className="ml-1 text-text-muted">{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Refresh split-button ─────────────────────────────────────────────────

function RefreshDropdown({
  onSoft,
  onHard,
  softBusy,
  hardBusy,
  disabled,
  lockedTitle,
}: {
  onSoft: () => void;
  onHard: () => void;
  softBusy: boolean;
  hardBusy: boolean;
  disabled: boolean;
  lockedTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);
  return (
    <div ref={ref} className="relative inline-flex">
      <Button
        size="sm"
        variant="outline"
        onClick={onSoft}
        disabled={softBusy || disabled}
        title={`refresh (re-render manifests against cached repo)${lockedTitle}`}
        className="rounded-r-none"
      >
        {softBusy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RefreshCw className="size-3.5" />
        )}
        refresh
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="-ml-px rounded-l-none px-1.5"
        aria-label="more refresh options"
      >
        <ChevronDown className="size-3" />
      </Button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 w-44 rounded-panel border border-border-default bg-surface shadow-[var(--shadow-popover)]">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onHard();
            }}
            disabled={hardBusy}
            className="block w-full px-3 py-2 text-left text-[12px] hover:bg-hover"
          >
            <div className="flex items-center gap-2 text-text-primary">
              {hardBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              hard refresh
            </div>
            <div className="mt-0.5 text-[10px] text-text-muted">
              re-clone the source repository
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Sync dialog ──────────────────────────────────────────────────────────

function SyncDialog({
  app,
  defaultRevision,
  managedResources,
  busy,
  onCancel,
  onSubmit,
}: {
  app: ArgoApplicationSummary;
  defaultRevision: string;
  managedResources: ArgoApplicationResource[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (opts: ArgoSyncOptions) => void;
}) {
  const [revision, setRevision] = useState(defaultRevision);
  const [prune, setPrune] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [force, setForce] = useState(false);
  const [replace, setReplace] = useState(false);
  const [serverSideApply, setServerSideApply] = useState(false);
  const [applyOutOfSyncOnly, setApplyOutOfSyncOnly] = useState(false);
  const [respectIgnoreDifferences, setRespectIgnoreDifferences] =
    useState(false);
  const [pruneLast, setPruneLast] = useState(false);
  const [retryEnabled, setRetryEnabled] = useState(false);
  const [retryLimit, setRetryLimit] = useState(5);
  const [resourceFilter, setResourceFilter] = useState(false);
  const [selectedResources, setSelectedResources] = useState<Set<string>>(
    new Set(),
  );

  function resKey(r: ArgoApplicationResource): string {
    return `${r.group}/${r.kind}/${r.namespace ?? ""}/${r.name}`;
  }

  function buildOptions(): ArgoSyncOptions {
    const opts: ArgoSyncOptions = {
      revision: revision.trim() || undefined,
      prune,
      dryRun,
      force,
      replace,
      serverSideApply,
      applyOutOfSyncOnly,
      respectIgnoreDifferences,
      pruneLast,
      retryLimit: retryEnabled ? retryLimit : null,
    };
    if (resourceFilter && selectedResources.size > 0) {
      opts.resources = managedResources
        .filter((r) => selectedResources.has(resKey(r)))
        .map((r) => ({
          group: r.group,
          kind: r.kind,
          name: r.name,
          namespace: r.namespace ?? undefined,
        }));
    }
    return opts;
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-panel border border-border-default bg-surface shadow-[var(--shadow-popover)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-default px-4 py-3">
          <div className="flex items-center gap-2">
            <Sliders className="size-3.5 text-accent-primary" />
            <div>
              <div className="text-[13px] font-medium text-text-primary">
                Sync {app.name}
              </div>
              <div className="text-[11px] text-text-muted">
                {app.namespace} · {app.project}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-text-muted hover:bg-elevated hover:text-text-primary"
            aria-label="cancel"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3">
          <Field label="revision">
            <Input
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
              placeholder="HEAD or specific tag / branch / SHA"
              className="font-mono"
            />
            <p className="mt-1 text-[10px] text-text-muted">
              Leave as <code>HEAD</code> to use what's currently in the
              Application spec.
            </p>
          </Field>

          <FieldGroup label="sync options">
            <CheckRow
              checked={prune}
              onChange={setPrune}
              label="Prune"
              hint="Delete resources removed from Git."
            />
            <CheckRow
              checked={dryRun}
              onChange={setDryRun}
              label="Dry run"
              hint="Server-side preview only — no changes applied."
            />
            <CheckRow
              checked={force}
              onChange={setForce}
              label="Force"
              hint="Pass --force to apply (overwrites conflicts)."
            />
            <CheckRow
              checked={applyOutOfSyncOnly}
              onChange={setApplyOutOfSyncOnly}
              label="Apply out-of-sync only"
              hint="Skip resources already at the target revision."
            />
            <CheckRow
              checked={replace}
              onChange={setReplace}
              label="Replace"
              hint="kubectl replace semantics instead of patch."
            />
            <CheckRow
              checked={serverSideApply}
              onChange={setServerSideApply}
              label="Server-side apply"
              hint="Apply with field-manager tracking."
            />
            <CheckRow
              checked={respectIgnoreDifferences}
              onChange={setRespectIgnoreDifferences}
              label="Respect ignoreDifferences"
              hint="Honor the spec.ignoreDifferences settings."
            />
            <CheckRow
              checked={pruneLast}
              onChange={setPruneLast}
              label="Prune last"
              hint="Run prune after the sync wave instead of before."
            />
          </FieldGroup>

          <FieldGroup label="retry">
            <CheckRow
              checked={retryEnabled}
              onChange={setRetryEnabled}
              label="Retry on failure"
              hint="Backoff: 5s start, x2 factor, 3min max."
            />
            {retryEnabled && (
              <div className="mt-1 flex items-center gap-2 pl-6 text-[11px]">
                <span className="text-text-muted">limit</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={retryLimit}
                  onChange={(e) =>
                    setRetryLimit(
                      Math.max(
                        1,
                        Math.min(20, Number.parseInt(e.target.value, 10) || 1),
                      ),
                    )
                  }
                  className="h-7 w-16 rounded border border-border-default bg-elevated px-2 text-text-primary"
                />
              </div>
            )}
          </FieldGroup>

          <FieldGroup label="resources">
            <CheckRow
              checked={resourceFilter}
              onChange={(v) => {
                setResourceFilter(v);
                if (!v) setSelectedResources(new Set());
              }}
              label="Sync a subset of resources"
              hint={
                managedResources.length > 0
                  ? `${managedResources.length} resources currently managed.`
                  : "Detail data not loaded yet — leave off to sync all."
              }
            />
            {resourceFilter && managedResources.length > 0 && (
              <div className="mt-2 max-h-44 overflow-auto rounded border border-border-subtle bg-elevated p-2">
                {managedResources.map((r) => {
                  const key = resKey(r);
                  const checked = selectedResources.has(key);
                  return (
                    <label
                      key={key}
                      className="flex items-center gap-2 py-0.5 text-[11px]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedResources((prev) => {
                            const next = new Set(prev);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                      />
                      <span className="font-mono text-text-muted">
                        {r.kind}
                      </span>
                      <span className="font-mono text-text-primary">
                        {r.name}
                      </span>
                      {r.namespace && (
                        <span className="font-mono text-text-muted">
                          · {r.namespace}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </FieldGroup>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-default px-4 py-3">
          <Button variant="outline" size="sm" onClick={onCancel}>
            cancel
          </Button>
          <Button
            size="sm"
            onClick={() => onSubmit(buildOptions())}
            disabled={busy}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {dryRun ? "dry-run sync" : "sync"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function FieldGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="mb-3">
      <legend className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">
        {label}
      </legend>
      <div className="space-y-1">{children}</div>
    </fieldset>
  );
}

function CheckRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-2 text-[12px] text-text-primary">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div>
        <div>{label}</div>
        {hint && <div className="text-[10px] text-text-muted">{hint}</div>}
      </div>
    </label>
  );
}

// ─── Resource + history rendering ─────────────────────────────────────────

function resourceKey(r: ArgoApplicationResource): string {
  return `${r.group}/${r.kind}/${r.namespace ?? ""}/${r.name}`;
}

function toDrawerResource(r: ArgoApplicationResource): {
  kind: string;
  namespace: string;
  name: string;
} {
  return {
    kind: argocdKindToLumenKind(r.kind),
    // ResourceDetailDrawer expects a string namespace; cluster-scoped
    // resources get an empty string and the drawer's K8s queries handle
    // that via `Api::all`.
    namespace: r.namespace ?? "",
    name: r.name,
  };
}

/**
 * Wrapper around the managed-resources panel: header (with view-mode
 * toggle), then either the flat alphabetical list or the kind-grouped
 * tree, depending on the user's persisted preference.
 *
 * The tree mode groups by Kind today; an owner-ref-based deeper tree
 * is on the roadmap once we either pull it from ArgoCD's status tree
 * endpoint or do per-resource K8s round-trips. Kind grouping is the
 * meaningful upgrade we can ship from data the backend already
 * returns (`ApplicationDetail.resources`).
 */
function ManagedResourcesSection({
  context,
  loading,
  resources,
  inCluster,
  readOnly,
  syncBusyKey,
  onOpen,
  onSync,
  filterText,
  onFilterChange,
  searchInputRef,
}: {
  context: string;
  loading: boolean;
  resources: ArgoApplicationResource[] | undefined;
  inCluster: boolean;
  readOnly: boolean;
  syncBusyKey: string | null;
  onOpen: (r: ArgoApplicationResource) => void;
  onSync: (r: ArgoApplicationResource) => void;
  filterText: string;
  onFilterChange: (next: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const view = useUiSettings((s) => s.argocdResourceView);
  const setView = useUiSettings((s) => s.setArgocdResourceView);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-text-muted">
        <Loader2 className="size-3 animate-spin" /> loading resources…
      </div>
    );
  }
  if (!resources || resources.length === 0) {
    return (
      <p className="text-[11px] text-text-muted">no managed resources yet</p>
    );
  }

  const trimmed = filterText.trim().toLowerCase();
  const filteredResources = trimmed
    ? resources.filter((r) => matchesResourceFilter(r, trimmed))
    : resources;

  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-muted">
        <span className="shrink-0">
          managed resources · {resources.length}
        </span>
        {!inCluster && (
          <span
            className="rounded border border-border-subtle px-1.5 py-0.5 text-[9px] text-text-muted normal-case tracking-normal"
            title="Application targets an external cluster — Lumen can sync via the Application CRD but can't open the K8s drawer for resources outside this kubeconfig context."
          >
            external dest
          </span>
        )}
        <ResourceSearchInput
          value={filterText}
          onChange={onFilterChange}
          inputRef={searchInputRef}
          shownCount={filteredResources.length}
          totalCount={resources.length}
        />
        <span className="shrink-0">
          <ViewModeToggle
            value={view}
            onChange={setView}
            // Topology fetches K8s objects per resource; only meaningful
            // for in-cluster destinations. Disable the topology button
            // when the destination is external rather than letting the
            // user pick a mode that will silently render as a flat list.
            topologyEnabled={inCluster}
          />
        </span>
      </div>
      {view === "topology" && inCluster ? (
        <ResourceTopology
          context={context}
          resources={resources}
          inCluster={inCluster}
          readOnly={readOnly}
          syncBusyKey={syncBusyKey}
          onOpen={onOpen}
          onSync={onSync}
        />
      ) : view === "tree" ? (
        <ResourceTree
          resources={resources}
          filterText={trimmed}
          inCluster={inCluster}
          readOnly={readOnly}
          syncBusyKey={syncBusyKey}
          onOpen={onOpen}
          onSync={onSync}
        />
      ) : (
        <ResourceFlatList
          resources={filteredResources}
          totalCount={resources.length}
          inCluster={inCluster}
          readOnly={readOnly}
          syncBusyKey={syncBusyKey}
          onOpen={onOpen}
          onSync={onSync}
        />
      )}
    </div>
  );
}

/**
 * Case-insensitive substring match against a resource's identifying
 * fields. `term` must already be lowercased — keeps the per-row check
 * free of allocations.
 */
function matchesResourceFilter(
  r: ArgoApplicationResource,
  term: string,
): boolean {
  if (!term) return true;
  if (r.name.toLowerCase().includes(term)) return true;
  if (r.kind.toLowerCase().includes(term)) return true;
  if (r.namespace && r.namespace.toLowerCase().includes(term)) return true;
  return false;
}

/**
 * Search input rendered inside the managed-resources header strip.
 * Owns its own keyboard ergonomics: Esc clears, blur-on-clear is left
 * to the user.
 */
function ResourceSearchInput({
  value,
  onChange,
  inputRef,
  shownCount,
  totalCount,
}: {
  value: string;
  onChange: (next: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  shownCount: number;
  totalCount: number;
}) {
  const hasFilter = value.length > 0;
  const allHidden = hasFilter && shownCount === 0;
  return (
    <div className="relative flex min-w-0 flex-1 items-center">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-1.5 size-3 text-text-muted"
      />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && hasFilter) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
        placeholder="Filter resources (press / to focus)"
        aria-label="filter managed resources"
        className={cn(
          "h-6 w-full min-w-0 rounded border border-border-default bg-elevated pl-6 pr-14 font-mono text-[10px] normal-case tracking-normal text-text-primary placeholder:text-text-muted",
          "focus:border-accent-primary focus:outline-none",
          allHidden && "border-warning/60",
        )}
      />
      <span className="pointer-events-none absolute right-6 font-mono text-[9px] tabular-nums text-text-muted normal-case tracking-normal">
        {hasFilter ? `${shownCount} of ${totalCount}` : ""}
      </span>
      {hasFilter && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="clear filter"
          title="clear filter (Esc)"
          className="absolute right-1 inline-flex items-center justify-center rounded p-0.5 text-text-muted hover:bg-elevated hover:text-text-primary"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/**
 * View-mode toggle. Three-state segmented control rendered inline in the
 * managed-resources header. Persists via uiSettings. The topology
 * option is gated on the destination being in-cluster — for external
 * destinations there's no Lumen K8s API to fetch owner refs from, so
 * we render the button disabled with a hint.
 */
function ViewModeToggle({
  value,
  onChange,
  topologyEnabled,
}: {
  value: ArgocdResourceView;
  onChange: (next: ArgocdResourceView) => void;
  topologyEnabled: boolean;
}) {
  const titleFor = (mode: ArgocdResourceView): string => {
    if (mode === "tree") return "group by Kind";
    if (mode === "topology") {
      return topologyEnabled
        ? "owner-ref topology (Deployment → ReplicaSet → Pod)"
        : "topology requires an in-cluster destination";
    }
    return "flat list";
  };
  return (
    <div
      className="inline-flex overflow-hidden rounded border border-border-default bg-surface text-text-secondary"
      role="tablist"
      aria-label="managed resources view"
    >
      {(["list", "tree", "topology"] as const).map((mode) => {
        const active = value === mode;
        const disabled = mode === "topology" && !topologyEnabled;
        return (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => {
              if (disabled) return;
              onChange(mode);
            }}
            disabled={disabled}
            title={titleFor(mode)}
            className={cn(
              "px-1.5 py-0.5 font-mono text-[10px] normal-case tracking-normal transition-colors",
              active
                ? "bg-accent-primary-soft text-accent-primary"
                : "hover:bg-hover",
              disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
          >
            {mode}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Flat alphabetical list — the original ResourceList, factored into
 * a component without its own header (the section header lives in
 * ManagedResourcesSection now).
 *
 * Receives the already-filtered slice so it doesn't need to know
 * about the search term itself; an empty list with a non-empty total
 * means "filter excluded everything" and we render a hint row.
 */
function ResourceFlatList({
  resources,
  totalCount,
  inCluster,
  readOnly,
  syncBusyKey,
  onOpen,
  onSync,
}: {
  resources: ArgoApplicationResource[];
  totalCount: number;
  inCluster: boolean;
  readOnly: boolean;
  syncBusyKey: string | null;
  onOpen: (r: ArgoApplicationResource) => void;
  onSync: (r: ArgoApplicationResource) => void;
}) {
  if (resources.length === 0 && totalCount > 0) {
    return (
      <p className="px-1 py-2 text-[11px] text-text-muted">
        No resources match the filter.
      </p>
    );
  }
  return (
    <ul className="max-h-72 space-y-0.5 overflow-auto pr-1 font-mono text-[11px]">
      {resources.map((r) => {
        const key = resourceKey(r);
        const syncBusy = syncBusyKey === key;
        return (
          <ResourceRow
            key={key}
            resource={r}
            inCluster={inCluster}
            readOnly={readOnly}
            syncBusy={syncBusy}
            onOpen={() => onOpen(r)}
            onSync={() => onSync(r)}
          />
        );
      })}
    </ul>
  );
}

/**
 * Kind-grouped tree. Each group is a collapsible section; resources
 * are rendered with the same ResourceRow as the flat list, just
 * indented one level so they read as children of the group header.
 *
 * Collapse state is per-render local to the panel — switching apps
 * resets it, which is fine since the tree is small (typical app: 5–30
 * resources across 4–10 Kinds). Persisting collapse per Kind is a
 * future improvement if users ask for it.
 *
 * Filter behaviour: when `filterText` is non-empty we hide groups
 * whose Kind has zero matches and show only matching rows inside
 * groups that do match. The header still shows the original kind
 * total ("3 of 47 visible") so users can see how aggressive the
 * filter is. The user's collapse choices are preserved when the
 * filter changes — re-opening a group that was collapsed before
 * filtering would feel surprising.
 */
function ResourceTree({
  resources,
  filterText,
  inCluster,
  readOnly,
  syncBusyKey,
  onOpen,
  onSync,
}: {
  resources: ArgoApplicationResource[];
  /** Lowercased + trimmed filter term. Empty string = no filter. */
  filterText: string;
  inCluster: boolean;
  readOnly: boolean;
  syncBusyKey: string | null;
  onOpen: (r: ArgoApplicationResource) => void;
  onSync: (r: ArgoApplicationResource) => void;
}) {
  const groups = useMemo(() => groupResourcesByKind(resources), [resources]);
  // Persisted globally via uiSettings so a workflow like "always hide
  // ConfigMaps" sticks across app switches and across cluster
  // workspaces. Falls back to "everything expanded" on first run.
  const collapsedList = useUiSettings((s) => s.argocdTreeCollapsed);
  const toggle = useUiSettings((s) => s.toggleArgocdTreeKind);
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);

  const hasFilter = filterText.length > 0;
  const filteredGroups = useMemo(() => {
    if (!hasFilter) {
      return groups.map((g) => ({
        kind: g.kind,
        resources: g.resources,
        total: g.resources.length,
      }));
    }
    return groups
      .map((g) => {
        const matches = g.resources.filter((r) =>
          matchesResourceFilter(r, filterText),
        );
        return { kind: g.kind, resources: matches, total: g.resources.length };
      })
      .filter((g) => g.resources.length > 0);
  }, [groups, hasFilter, filterText]);

  if (hasFilter && filteredGroups.length === 0) {
    return (
      <p className="px-1 py-2 text-[11px] text-text-muted">
        No resources match the filter.
      </p>
    );
  }

  return (
    <div className="max-h-72 space-y-1 overflow-auto pr-1 font-mono text-[11px]">
      {filteredGroups.map((group) => {
        // While a filter is active we ignore collapse state — the user
        // is searching and wants to see the matches. Once they clear
        // the filter their collapse choices come back.
        const isCollapsed = !hasFilter && collapsed.has(group.kind);
        const showCount =
          hasFilter && group.resources.length !== group.total
            ? `${group.resources.length} of ${group.total}`
            : `${group.total}`;
        return (
          <div key={group.kind}>
            <button
              type="button"
              onClick={() => toggle(group.kind)}
              className="group/group flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-elevated"
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? (
                <ChevronRight
                  className="size-3 text-text-muted"
                  aria-hidden="true"
                />
              ) : (
                <ChevronDown
                  className="size-3 text-text-muted"
                  aria-hidden="true"
                />
              )}
              <span className="text-text-primary">{group.kind}</span>
              <span className="text-text-muted">· {showCount}</span>
            </button>
            {!isCollapsed && (
              <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-border-subtle pl-2">
                {group.resources.map((r) => {
                  const key = resourceKey(r);
                  const syncBusy = syncBusyKey === key;
                  return (
                    <ResourceRow
                      key={key}
                      resource={r}
                      inCluster={inCluster}
                      readOnly={readOnly}
                      syncBusy={syncBusy}
                      onOpen={() => onOpen(r)}
                      onSync={() => onSync(r)}
                      hideKind
                    />
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Owner-reference topology view.
 *
 * For each managed resource that's in-cluster we issue a parallel
 * `k8s.getResource` query (cached for 30s via React Query). The result
 * gives us `metadata.ownerReferences` from which we build a real
 * Deployment → ReplicaSet → Pod tree. Resources whose K8s objects
 * Lumen doesn't know about (cluster-scoped CRDs, kinds not in the
 * WorkloadKind enum, RBAC failures) gracefully degrade to roots —
 * they show up at the top level alongside everything else.
 *
 * UX:
 *  • Loading shows a "loading topology…" line with X / Y progress.
 *  • Once enough has arrived to draw, we render incrementally — every
 *    resource shows up immediately as a root and re-parents itself
 *    when its owner-fetch resolves. This keeps the panel useful even
 *    on apps with hundreds of pods.
 *  • Same ResourceRow leaf as the kind-grouped tree, with depth-based
 *    indent and chevron-collapse markers. Collapse state is local to
 *    this render — the user is exploring topology, not curating a
 *    persistent shape.
 */
function ResourceTopology({
  context,
  resources,
  inCluster,
  readOnly,
  syncBusyKey,
  onOpen,
  onSync,
}: {
  context: string;
  resources: ArgoApplicationResource[];
  inCluster: boolean;
  readOnly: boolean;
  syncBusyKey: string | null;
  onOpen: (r: ArgoApplicationResource) => void;
  onSync: (r: ArgoApplicationResource) => void;
}) {
  // Stable key per resource → React Query cache hit on re-renders.
  const queries = useQueries({
    queries: resources.map((r) => {
      const lumenKind = argocdKindToLumenKind(r.kind) as WorkloadKind;
      const namespace = r.namespace ?? "";
      return {
        queryKey: [
          "argocd-topology",
          context,
          lumenKind,
          namespace,
          r.name,
        ] as const,
        queryFn: () =>
          k8s.getResource(namespace, lumenKind, r.name, context || undefined),
        staleTime: 30_000,
        // Topology fetches are best-effort enrichment — failures map
        // to a root-level node, not an error toast. retry=false avoids
        // spending tokens on cluster-scoped CRDs Lumen doesn't model.
        retry: false,
      };
    }),
  });

  const loadedCount = queries.filter((q) => !q.isPending).length;
  const totalCount = resources.length;

  // Build the (resource → owner-fact) list, then the tree. We pass
  // `undefined` for resources whose query is still pending so the
  // builder treats them as roots until the fetch resolves — that's
  // what keeps the view incremental.
  const treeInput: ResourceWithOwner[] = useMemo(() => {
    return resources.map((resource, i) => {
      const q = queries[i];
      if (q.isPending) return { resource, owner: undefined };
      if (q.isError || !q.data) return { resource, owner: undefined };
      const refs = q.data.owner_refs ?? [];
      const first = refs[0];
      const owner: OwnerFact | null = first
        ? { kind: first.kind, name: first.name }
        : null;
      return { resource, owner };
    });
    // queries change identity each render but their .data / .isPending
    // are stable — we'd over-rebuild without depending on the loaded
    // count + identity of each resource. eslint-disable-next-line is
    // intentional; the value-shape change is what we care about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resources, loadedCount, totalCount]);

  const tree = useMemo(() => buildOwnerTree(treeInput), [treeInput]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);

  function toggleCollapsed(key: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div>
      {loadedCount < totalCount && (
        <div className="mb-1 flex items-center gap-2 text-[10px] text-text-muted">
          <Loader2 className="size-3 animate-spin" />
          <span>
            loading topology… {loadedCount} / {totalCount}
          </span>
        </div>
      )}
      <ul className="max-h-72 space-y-0.5 overflow-auto pr-1 font-mono text-[11px]">
        {rows.map((row) => {
          const isCollapsed = collapsed.has(row.key);
          const syncBusy = syncBusyKey === resourceKey(row.resource);
          return (
            <ResourceRow
              key={row.key}
              resource={row.resource}
              inCluster={inCluster}
              readOnly={readOnly}
              syncBusy={syncBusy}
              onOpen={() => onOpen(row.resource)}
              onSync={() => onSync(row.resource)}
              indentLevel={row.depth}
              expandable={
                row.hasChildren
                  ? { collapsed: isCollapsed, onToggle: () => toggleCollapsed(row.key) }
                  : undefined
              }
            />
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One managed-resource row. Click → opens the Lumen drawer. Hover →
 * exposes a per-resource Sync button. Lockable by readOnly.
 */
function ResourceRow({
  resource,
  inCluster,
  readOnly,
  syncBusy,
  onOpen,
  onSync,
  hideKind = false,
  indentLevel,
  expandable,
}: {
  resource: ArgoApplicationResource;
  inCluster: boolean;
  readOnly: boolean;
  syncBusy: boolean;
  onOpen: () => void;
  onSync: () => void;
  /**
   * In tree-view, the Kind label is redundant — it's already in the
   * group header. Suppress it on the row so we don't say "Deployment"
   * twice.
   */
  hideKind?: boolean;
  /** Topology view: depth in the owner tree (0 = root). */
  indentLevel?: number;
  /** Topology view: chevron-collapse marker for nodes with children. */
  expandable?: { collapsed: boolean; onToggle: () => void };
}) {
  const lockedTitle = readOnly ? " (read-only mode)" : "";
  const openLabel = inCluster
    ? `open ${resource.kind}/${resource.name} in drawer`
    : `external destination — drawer is only available for in-cluster resources`;
  const indentPx = indentLevel ? indentLevel * 12 : 0;
  return (
    <li
      className={cn(
        "group relative flex items-center gap-2 rounded px-1 py-0.5 transition-colors",
        inCluster ? "cursor-pointer hover:bg-elevated" : "opacity-90",
      )}
      style={indentPx > 0 ? { paddingLeft: indentPx + 4 } : undefined}
      onClick={inCluster ? onOpen : undefined}
      title={openLabel}
    >
      {expandable ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            expandable.onToggle();
          }}
          aria-label={expandable.collapsed ? "expand subtree" : "collapse subtree"}
          className="-ml-1 inline-flex shrink-0 items-center text-text-muted hover:text-text-primary"
        >
          {expandable.collapsed ? (
            <ChevronRight className="size-3" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3" aria-hidden="true" />
          )}
        </button>
      ) : indentLevel !== undefined ? (
        // Spacer so leaf rows align with their expandable siblings.
        <span className="inline-block size-3 shrink-0" aria-hidden="true" />
      ) : null}
      <ResourceDot sync={resource.sync_status} health={resource.health_status} />
      {!hideKind && <span className="text-text-muted">{resource.kind}</span>}
      <span className="text-text-primary">{resource.name}</span>
      {resource.namespace && (
        <span className="text-text-muted">· {resource.namespace}</span>
      )}
      {resource.health_message && (
        <span
          className="truncate text-warning"
          title={resource.health_message}
        >
          {resource.health_message}
        </span>
      )}
      {/*
        Per-resource actions, revealed on hover. We deliberately don't
        nest a button inside the clickable <li> for the sync action —
        instead we use stopPropagation so the row click still works on
        the rest of the row.
      */}
      <span className="ml-auto inline-flex items-center gap-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSync();
          }}
          disabled={syncBusy || readOnly}
          title={`sync only this resource${lockedTitle}`}
          className={cn(
            "invisible inline-flex items-center gap-1 rounded border border-border-default bg-surface px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-primary group-hover:visible disabled:invisible",
          )}
        >
          {syncBusy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Zap className="size-3" />
          )}
          sync
        </button>
        {inCluster ? (
          <ChevronRight
            className="size-3 text-text-muted opacity-0 group-hover:opacity-70"
            aria-hidden="true"
          />
        ) : (
          <ExternalLink
            className="size-3 text-text-muted opacity-50"
            aria-hidden="true"
          />
        )}
      </span>
    </li>
  );
}

function HistoryList({
  history,
  onRollback,
  disabled,
  lockedTitle,
}: {
  history: ArgoHistoryEntry[];
  onRollback: (entry: ArgoHistoryEntry) => void;
  disabled: boolean;
  lockedTitle: string;
}) {
  return (
    <div className="mt-4">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-text-muted">
        <HistoryIcon className="size-3" />
        history
      </div>
      <ul className="space-y-0.5 font-mono text-[11px]">
        {history.slice(0, 5).map((h) => (
          <li
            key={`${h.revision}-${h.deployed_at ?? ""}`}
            className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-elevated"
          >
            <span className="text-text-muted">{h.revision.slice(0, 7)}</span>
            <span className="flex-1 truncate text-text-secondary">
              {h.deployed_at ?? ""}
            </span>
            <button
              type="button"
              onClick={() => onRollback(h)}
              disabled={disabled}
              title={`rollback to ${h.revision.slice(0, 7)}${lockedTitle}`}
              className="invisible inline-flex items-center gap-1 rounded border border-border-default bg-surface px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-primary group-hover:visible disabled:invisible"
            >
              <RotateCcw className="size-3" />
              rollback
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Pills + helpers ──────────────────────────────────────────────────────

function SyncPill({ status }: { status: string }) {
  const cls =
    status === "Synced"
      ? "border-success/40 bg-success-soft text-success"
      : status === "OutOfSync"
        ? "border-warning/40 bg-warning-soft text-warning"
        : "border-border-default bg-elevated text-text-muted";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase",
        cls,
      )}
    >
      {status === "Synced" ? (
        <CheckCircle2 className="size-3" />
      ) : status === "OutOfSync" ? (
        <AlertTriangle className="size-3" />
      ) : (
        <ShieldQuestion className="size-3" />
      )}
      {status}
    </span>
  );
}

function HealthPill({ status }: { status: string }) {
  const cls =
    status === "Healthy"
      ? "border-success/40 bg-success-soft text-success"
      : status === "Degraded"
        ? "border-danger/40 bg-danger-soft text-danger"
        : status === "Progressing"
          ? "border-info/40 bg-info-soft text-info"
          : "border-border-default bg-elevated text-text-muted";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase",
        cls,
      )}
    >
      {status}
    </span>
  );
}

function ResourceDot({
  sync,
  health,
}: {
  sync: string | null;
  health: string | null;
}) {
  let color = "bg-border-subtle";
  if (health === "Healthy") color = "bg-success";
  else if (health === "Degraded") color = "bg-danger";
  else if (health === "Progressing") color = "bg-info";
  else if (sync === "OutOfSync") color = "bg-warning";
  else if (sync === "Synced") color = "bg-success";
  return <span className={cn("size-1.5 shrink-0 rounded-full", color)} />;
}

function DetailRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-text-muted">
        {icon}
        {icon ? " " : ""}
        {label}
      </span>
      <span
        className="min-w-0 truncate font-mono text-text-primary"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <DataTableHead className="whitespace-nowrap text-[10px]">
      {children}
    </DataTableHead>
  );
}

// ─── ApplicationSets tab ──────────────────────────────────────────────────
//
// Mirrors the Applications tab structure (filter strip, master/detail
// split) but pared down — no sync/refresh/rollback CTAs. v1 is read-only
// while we figure out which AppSet mutations are safe to expose without
// a confirm dialog (template patches are scary).

function ApplicationSetsTab({ context }: { context: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedKey = searchParams.get("appset") ?? null;
  const [filter, setFilter] = useState("");

  const list = useQuery({
    queryKey: ["argocd", "appsets", context],
    queryFn: () => k8s.listArgocdApplicationSets(context || undefined),
    staleTime: 5_000,
    refetchInterval: 30_000,
  });

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const data = list.data ?? [];
    if (!q) return data;
    return data.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.namespace.toLowerCase().includes(q) ||
        (s.generator_kind ?? "").toLowerCase().includes(q),
    );
  }, [list.data, filter]);

  const selected = useMemo(() => {
    if (!selectedKey) return null;
    return (list.data ?? []).find(
      (s) => `${s.namespace}/${s.name}` === selectedKey,
    );
  }, [list.data, selectedKey]);

  function selectAppSet(s: ArgoApplicationSetSummary | null): void {
    const next = new URLSearchParams(searchParams);
    if (s) next.set("appset", `${s.namespace}/${s.name}`);
    else next.delete("appset");
    setSearchParams(next, { replace: true });
  }

  function jumpToApplication(namespace: string, name: string): void {
    const next = new URLSearchParams(searchParams);
    next.delete("tab");
    next.delete("appset");
    next.set("app", `${namespace}/${name}`);
    setSearchParams(next, { replace: true });
  }

  return (
    <>
      <PageHeader
        eyebrow="argocd"
        title="ApplicationSets"
        description="Templated Application generators. List/git/cluster/matrix generators expand into a fleet of Applications visible on the Applications tab."
        icon={<Layers className="size-4" />}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => list.refetch()}
            disabled={list.isFetching}
          >
            <RefreshCw
              className={cn("size-3.5", list.isFetching && "animate-spin")}
            />
            refresh list
          </Button>
        }
      />

      <SectionPanel className="py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter by name / namespace / generator"
            className="h-8 w-72"
          />
          <span className="ml-auto text-[11px] text-text-muted tabular-nums">
            {filtered.length} of {list.data?.length ?? 0}
          </span>
        </div>
      </SectionPanel>

      {list.error ? (
        <SectionPanel className="border border-danger/30 bg-[var(--status-error-soft)]">
          <p className="text-[12px] text-danger">
            {(list.error as Error).message ?? "failed to fetch ApplicationSets"}
          </p>
        </SectionPanel>
      ) : list.isLoading ? (
        <SectionPanel>
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            <Loader2 className="size-3.5 animate-spin" /> loading ApplicationSets…
          </div>
        </SectionPanel>
      ) : (list.data ?? []).length === 0 ? (
        <SectionPanel>
          <p className="text-[12px] text-text-muted">
            No ApplicationSets found. The CRD ships with the standard ArgoCD
            install but is unused on this cluster — Applications are
            either hand-crafted or templated by something else.
          </p>
        </SectionPanel>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
          <SectionPanel className="overflow-hidden p-0">
            <DataTableShell>
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <Th>name</Th>
                    <Th>namespace</Th>
                    <Th>generator</Th>
                    <Th>generated</Th>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((s) => {
                    const key = `${s.namespace}/${s.name}`;
                    const active = selectedKey === key;
                    return (
                      <DataTableRow
                        key={key}
                        onClick={() => selectAppSet(s)}
                        className={cn(
                          "cursor-pointer",
                          active && "bg-accent-primary-soft",
                        )}
                      >
                        <DataTableCell className="px-4">
                          <span className="text-[13px] font-medium text-text-primary">
                            {s.name}
                          </span>
                        </DataTableCell>
                        <DataTableCell mono className="text-[11px]">
                          {s.namespace}
                        </DataTableCell>
                        <DataTableCell>
                          <GeneratorPill kind={s.generator_kind} />
                        </DataTableCell>
                        <DataTableCell mono className="text-[11px] tabular-nums">
                          {s.generated_count}
                        </DataTableCell>
                      </DataTableRow>
                    );
                  })}
                </DataTableBody>
              </DataTable>
            </DataTableShell>
            {filtered.length === 0 && (
              <p className="px-4 py-3 text-[11px] text-text-muted">
                No ApplicationSets match the current filter.
              </p>
            )}
          </SectionPanel>

          {selected ? (
            <ApplicationSetDetailPanel
              context={context}
              appSet={selected}
              onClose={() => selectAppSet(null)}
              onJumpToApplication={jumpToApplication}
            />
          ) : (
            <SectionPanel>
              <p className="text-[12px] text-text-muted">
                Select an ApplicationSet to view its generator spec, template,
                and the Applications it currently materializes.
              </p>
            </SectionPanel>
          )}
        </div>
      )}
    </>
  );
}

function GeneratorPill({ kind }: { kind: string | null }) {
  if (!kind) {
    return (
      <span className="inline-flex rounded border border-border-default bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
        none
      </span>
    );
  }
  return (
    <span className="inline-flex rounded border border-info/40 bg-info-soft px-1.5 py-0.5 font-mono text-[10px] text-info">
      {kind}
    </span>
  );
}

function ApplicationSetDetailPanel({
  context,
  appSet,
  onClose,
  onJumpToApplication,
}: {
  context: string;
  appSet: ArgoApplicationSetSummary;
  onClose: () => void;
  onJumpToApplication: (namespace: string, name: string) => void;
}) {
  const detail = useQuery({
    queryKey: [
      "argocd",
      "appset",
      context,
      appSet.namespace,
      appSet.name,
    ] as const,
    queryFn: () =>
      k8s.getArgocdApplicationSet(
        context || undefined,
        appSet.namespace,
        appSet.name,
      ),
    staleTime: 1_000,
    refetchInterval: 15_000,
  });

  return (
    <SectionPanel className="self-start">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="mds-heading text-[14px] text-text-primary truncate">
            {appSet.name}
          </h2>
          <p className="font-mono text-[11px] text-text-muted">
            {appSet.namespace}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-text-muted hover:bg-elevated hover:text-text-primary"
          aria-label="close"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <GeneratorPill kind={appSet.generator_kind} />
        <span className="rounded border border-border-default bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
          {appSet.generated_count} apps
        </span>
      </div>

      {appSet.template_app_name_pattern && (
        <div className="mb-3 text-[11px]">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
            template app name
          </div>
          <code className="block break-all rounded border border-border-subtle bg-elevated px-2 py-1 font-mono text-[11px] text-text-primary">
            {appSet.template_app_name_pattern}
          </code>
        </div>
      )}

      {detail.isLoading ? (
        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          <Loader2 className="size-3 animate-spin" /> loading detail…
        </div>
      ) : detail.error ? (
        <p className="text-[11px] text-danger">
          {(detail.error as Error).message ?? "failed to fetch detail"}
        </p>
      ) : detail.data ? (
        <>
          {detail.data.generators_yaml && (
            <YamlBlock label="generators" yaml={detail.data.generators_yaml} />
          )}
          {detail.data.template_yaml && (
            <YamlBlock label="template" yaml={detail.data.template_yaml} />
          )}
          <div className="mt-4">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
              generated applications · {detail.data.generated_apps.length}
            </div>
            {detail.data.generated_apps.length === 0 ? (
              <p className="text-[11px] text-text-muted">
                The status block doesn't list any generated Applications yet.
                Reconciliation may be in progress.
              </p>
            ) : (
              <ul className="max-h-44 space-y-0.5 overflow-auto pr-1 font-mono text-[11px]">
                {detail.data.generated_apps.map((g) => {
                  const key = `${g.namespace}/${g.name}`;
                  return (
                    <li
                      key={key}
                      className="group flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-elevated"
                      onClick={() => onJumpToApplication(g.namespace, g.name)}
                      title={`open ${g.name} on the Applications tab`}
                    >
                      <ResourceDot
                        sync={g.sync_status}
                        health={g.health_status}
                      />
                      <span className="text-text-primary">{g.name}</span>
                      <span className="text-text-muted">· {g.namespace}</span>
                      <span className="ml-auto inline-flex items-center gap-1">
                        <SyncPill status={g.sync_status} />
                        <HealthPill status={g.health_status} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </SectionPanel>
  );
}

function YamlBlock({ label, yaml }: { label: string; yaml: string }) {
  return (
    <div className="mb-3">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
        {label}
      </div>
      <pre className="max-h-48 overflow-auto rounded border border-border-subtle bg-elevated p-2 font-mono text-[10px] text-text-primary">
        {yaml}
      </pre>
    </div>
  );
}

// ─── AppProjects tab ──────────────────────────────────────────────────────
//
// Read-only list of project boundaries. Detail panel renders source-repo
// allowlist, destinations, cluster/namespace resource whitelists, and
// roles. CRUD is a clean follow-up.

function AppProjectsTab({ context }: { context: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedKey = searchParams.get("project") ?? null;
  const [filter, setFilter] = useState("");

  const list = useQuery({
    queryKey: ["argocd", "projects", context],
    queryFn: () => k8s.listArgocdAppProjects(context || undefined),
    staleTime: 5_000,
    refetchInterval: 60_000,
  });

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const data = list.data ?? [];
    if (!q) return data;
    return data.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q),
    );
  }, [list.data, filter]);

  const selected = useMemo(() => {
    if (!selectedKey) return null;
    return (list.data ?? []).find(
      (p) => `${p.namespace}/${p.name}` === selectedKey,
    );
  }, [list.data, selectedKey]);

  function selectProject(p: ArgoAppProjectSummary | null): void {
    const next = new URLSearchParams(searchParams);
    if (p) next.set("project", `${p.namespace}/${p.name}`);
    else next.delete("project");
    setSearchParams(next, { replace: true });
  }

  return (
    <>
      <PageHeader
        eyebrow="argocd"
        title="AppProjects"
        description="Project boundaries that scope source repos, destination clusters, allowed resource kinds, and per-role policies."
        icon={<ServerCog className="size-4" />}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => list.refetch()}
            disabled={list.isFetching}
          >
            <RefreshCw
              className={cn("size-3.5", list.isFetching && "animate-spin")}
            />
            refresh list
          </Button>
        }
      />

      <SectionPanel className="py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter by name / description"
            className="h-8 w-72"
          />
          <span className="ml-auto text-[11px] text-text-muted tabular-nums">
            {filtered.length} of {list.data?.length ?? 0}
          </span>
        </div>
      </SectionPanel>

      {list.error ? (
        <SectionPanel className="border border-danger/30 bg-[var(--status-error-soft)]">
          <p className="text-[12px] text-danger">
            {(list.error as Error).message ?? "failed to fetch AppProjects"}
          </p>
        </SectionPanel>
      ) : list.isLoading ? (
        <SectionPanel>
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            <Loader2 className="size-3.5 animate-spin" /> loading AppProjects…
          </div>
        </SectionPanel>
      ) : (list.data ?? []).length === 0 ? (
        <SectionPanel>
          <p className="text-[12px] text-text-muted">
            No AppProjects found. ArgoCD always ships with a `default`
            project — its absence usually means RBAC is blocking the read.
          </p>
        </SectionPanel>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
          <SectionPanel className="overflow-hidden p-0">
            <DataTableShell>
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <Th>name</Th>
                    <Th>description</Th>
                    <Th>repos</Th>
                    <Th>destinations</Th>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filtered.map((p) => {
                    const key = `${p.namespace}/${p.name}`;
                    const active = selectedKey === key;
                    return (
                      <DataTableRow
                        key={key}
                        onClick={() => selectProject(p)}
                        className={cn(
                          "cursor-pointer",
                          active && "bg-accent-primary-soft",
                        )}
                      >
                        <DataTableCell className="px-4">
                          <span className="text-[13px] font-medium text-text-primary">
                            {p.name}
                          </span>
                        </DataTableCell>
                        <DataTableCell className="text-[11px] truncate">
                          {p.description || "—"}
                        </DataTableCell>
                        <DataTableCell mono className="text-[11px] tabular-nums">
                          {p.source_repos_count}
                        </DataTableCell>
                        <DataTableCell mono className="text-[11px] tabular-nums">
                          {p.destinations_count}
                        </DataTableCell>
                      </DataTableRow>
                    );
                  })}
                </DataTableBody>
              </DataTable>
            </DataTableShell>
            {filtered.length === 0 && (
              <p className="px-4 py-3 text-[11px] text-text-muted">
                No AppProjects match the current filter.
              </p>
            )}
          </SectionPanel>

          {selected ? (
            <AppProjectDetailPanel
              context={context}
              project={selected}
              onClose={() => selectProject(null)}
            />
          ) : (
            <SectionPanel>
              <p className="text-[12px] text-text-muted">
                Select an AppProject to view its source-repo allowlist,
                destinations, resource whitelists, and roles.
              </p>
            </SectionPanel>
          )}
        </div>
      )}
    </>
  );
}

function AppProjectDetailPanel({
  context,
  project,
  onClose,
}: {
  context: string;
  project: ArgoAppProjectSummary;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: [
      "argocd",
      "project",
      context,
      project.namespace,
      project.name,
    ] as const,
    queryFn: () =>
      k8s.getArgocdAppProject(
        context || undefined,
        project.namespace,
        project.name,
      ),
    staleTime: 1_000,
    refetchInterval: 30_000,
  });

  return (
    <SectionPanel className="self-start">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="mds-heading text-[14px] text-text-primary truncate">
            {project.name}
          </h2>
          <p className="font-mono text-[11px] text-text-muted">
            {project.namespace}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-text-muted hover:bg-elevated hover:text-text-primary"
          aria-label="close"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {project.description && (
        <p className="mb-3 text-[12px] text-text-secondary">
          {project.description}
        </p>
      )}

      {detail.isLoading ? (
        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          <Loader2 className="size-3 animate-spin" /> loading detail…
        </div>
      ) : detail.error ? (
        <p className="text-[11px] text-danger">
          {(detail.error as Error).message ?? "failed to fetch detail"}
        </p>
      ) : detail.data ? (
        <div className="space-y-4">
          <ProjectListSection
            label={`source repos · ${detail.data.source_repos.length}`}
            empty="No source repos allowed — every Application referencing this project will be rejected."
          >
            {detail.data.source_repos.map((repo) => (
              <li key={repo} className="truncate text-text-primary" title={repo}>
                {repo}
              </li>
            ))}
          </ProjectListSection>
          <ProjectListSection
            label={`destinations · ${detail.data.destinations.length}`}
            empty="No destinations allowed."
          >
            {detail.data.destinations.map((d, i) => (
              <li
                key={`${d.server}|${d.namespace}|${i}`}
                className="text-text-primary"
              >
                <span className="text-text-muted">{d.namespace || "*"}</span>
                <span className="text-text-muted"> @ </span>
                <span>{d.server || "*"}</span>
              </li>
            ))}
          </ProjectListSection>
          <ProjectListSection
            label={`cluster resource whitelist · ${detail.data.cluster_resource_whitelist.length}`}
            empty="No cluster-scoped resources allowed."
          >
            {detail.data.cluster_resource_whitelist.map((r, i) => (
              <li key={`${r.group}/${r.kind}/${i}`} className="text-text-primary">
                <span className="text-text-muted">
                  {r.group || "core"}/
                </span>
                {r.kind}
              </li>
            ))}
          </ProjectListSection>
          <ProjectListSection
            label={`namespace resource whitelist · ${detail.data.namespace_resource_whitelist.length}`}
            empty="No namespace-scoped resources allowed."
          >
            {detail.data.namespace_resource_whitelist.map((r, i) => (
              <li key={`${r.group}/${r.kind}/${i}`} className="text-text-primary">
                <span className="text-text-muted">
                  {r.group || "core"}/
                </span>
                {r.kind}
              </li>
            ))}
          </ProjectListSection>
          {detail.data.roles.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
                roles · {detail.data.roles.length}
              </div>
              <ul className="space-y-2">
                {detail.data.roles.map((role) => (
                  <li
                    key={role.name}
                    className="rounded border border-border-subtle bg-elevated p-2"
                  >
                    <div className="text-[12px] font-medium text-text-primary">
                      {role.name}
                    </div>
                    {role.description && (
                      <div className="mt-0.5 text-[11px] text-text-muted">
                        {role.description}
                      </div>
                    )}
                    {role.policies.length > 0 && (
                      <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-text-primary">
                        {role.policies.join("\n")}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </SectionPanel>
  );
}

function ProjectListSection({
  label,
  empty,
  children,
}: {
  label: string;
  empty: string;
  children: React.ReactNode;
}) {
  // children is always an array of <li>; check by counting via React.
  const hasChildren = Array.isArray(children)
    ? children.length > 0
    : Boolean(children);
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
        {label}
      </div>
      {hasChildren ? (
        <ul className="max-h-32 space-y-0.5 overflow-auto pr-1 font-mono text-[11px]">
          {children}
        </ul>
      ) : (
        <p className="text-[11px] text-text-muted">{empty}</p>
      )}
    </div>
  );
}
