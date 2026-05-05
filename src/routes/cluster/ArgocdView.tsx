import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleStop,
  ExternalLink,
  GitBranch,
  History as HistoryIcon,
  Loader2,
  RefreshCw,
  RotateCcw,
  RotateCw,
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
  type ArgoHistoryEntry,
  type ArgoSyncOptions,
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
import { useUiSettings } from "@/state/uiSettings";

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

export function ArgocdView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
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
    <LumenPage>
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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
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

          {selected ? (
            <ApplicationDetailPanel
              context={context}
              app={selected}
              readOnly={readOnly}
              onClose={() => selectApp(null)}
              onMutated={() => {
                qc.invalidateQueries({ queryKey: ["argocd", "apps", context] });
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
                Select an application to see its sync state, managed resources,
                and run actions.
              </p>
            </SectionPanel>
          )}
        </div>
      )}
    </LumenPage>
  );
}

function toggleSet<T>(prev: Set<T>, value: T): Set<T> {
  const next = new Set(prev);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
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

      <ResourceList
        loading={detail.isLoading}
        resources={detail.data?.resources}
        inCluster={inCluster}
        readOnly={readOnly}
        syncBusyKey={perResourceSyncBusy}
        onOpen={(r) => setDrawerResource(toDrawerResource(r))}
        onSync={(r) => void performSyncResource(r)}
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

function ResourceList({
  loading,
  resources,
  inCluster,
  readOnly,
  syncBusyKey,
  onOpen,
  onSync,
}: {
  loading: boolean;
  resources: ArgoApplicationResource[] | undefined;
  inCluster: boolean;
  readOnly: boolean;
  syncBusyKey: string | null;
  onOpen: (r: ArgoApplicationResource) => void;
  onSync: (r: ArgoApplicationResource) => void;
}) {
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
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-muted">
        <span>managed resources · {resources.length}</span>
        {!inCluster && (
          <span
            className="rounded border border-border-subtle px-1.5 py-0.5 text-[9px] text-text-muted normal-case tracking-normal"
            title="Application targets an external cluster — Lumen can sync via the Application CRD but can't open the K8s drawer for resources outside this kubeconfig context."
          >
            external dest
          </span>
        )}
      </div>
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
}: {
  resource: ArgoApplicationResource;
  inCluster: boolean;
  readOnly: boolean;
  syncBusy: boolean;
  onOpen: () => void;
  onSync: () => void;
}) {
  const lockedTitle = readOnly ? " (read-only mode)" : "";
  const openLabel = inCluster
    ? `open ${resource.kind}/${resource.name} in drawer`
    : `external destination — drawer is only available for in-cluster resources`;
  return (
    <li
      className={cn(
        "group relative flex items-center gap-2 rounded px-1 py-0.5 transition-colors",
        inCluster ? "cursor-pointer hover:bg-elevated" : "opacity-90",
      )}
      onClick={inCluster ? onOpen : undefined}
      title={openLabel}
    >
      <ResourceDot sync={resource.sync_status} health={resource.health_status} />
      <span className="text-text-muted">{resource.kind}</span>
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
