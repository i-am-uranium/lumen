import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  Loader2,
  RefreshCw,
  RotateCw,
  ServerCog,
  ShieldQuestion,
} from "lucide-react";
import { toast } from "sonner";
import {
  k8s,
  type ArgoApplicationDetail,
  type ArgoApplicationSummary,
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
import { useUiSettings } from "@/state/uiSettings";

/**
 * ArgoCD Applications view.
 *
 * Lists every Application CRD in the cluster (across namespaces by
 * default — most ArgoCD installs put Applications in the `argocd`
 * namespace anyway, but we don't hard-code that). Click a row to open
 * the detail panel on the right; sync/refresh actions live in the panel.
 *
 * The list query runs every 15s when the route is mounted so users
 * watching a sync progress see the OutOfSync → Progressing → Synced
 * transition without manual refresh. The detail query polls slightly
 * faster (5s) while a row is selected.
 */
export function ArgocdView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const qc = useQueryClient();
  const readOnly = useUiSettings((s) => s.readOnly);

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedKey = searchParams.get("app") ?? null;
  const [filter, setFilter] = useState("");

  const apps = useQuery({
    queryKey: ["argocd", "apps", context],
    queryFn: () => k8s.listArgocdApplications(context || undefined),
    staleTime: 5_000,
    refetchInterval: 15_000,
  });

  const filteredApps = useMemo(() => {
    const list = apps.data ?? [];
    if (!filter.trim()) return list;
    const f = filter.toLowerCase();
    return list.filter(
      (a) =>
        a.name.toLowerCase().includes(f) ||
        a.namespace.toLowerCase().includes(f) ||
        a.project.toLowerCase().includes(f) ||
        a.repo_url.toLowerCase().includes(f),
    );
  }, [apps.data, filter]);

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

  return (
    <LumenPage>
      <PageHeader
        eyebrow="argocd"
        title="Applications"
        description="GitOps state of every ArgoCD Application reachable in this cluster. Sync / refresh actions write directly to the CRD."
        icon={<ServerCog className="size-4" />}
        actions={
          <div className="flex items-center gap-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by name / namespace / repo"
              className="h-8 w-72"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => apps.refetch()}
              disabled={apps.isFetching}
            >
              <RefreshCw
                className={cn("size-3.5", apps.isFetching && "animate-spin")}
              />
              refresh
            </Button>
          </div>
        }
      />

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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
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
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const lockedTitle = readOnly ? " (read-only mode)" : "";

  async function doSync(prune: boolean, dryRun: boolean) {
    setSyncing(true);
    try {
      await k8s.syncArgocdApplication(
        context || undefined,
        app.namespace,
        app.name,
        prune,
        dryRun,
      );
      toast.success(
        dryRun ? "dry-run sync requested" : `sync requested for ${app.name}`,
      );
      onMutated();
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function doRefresh(hard: boolean) {
    setRefreshing(true);
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
      setRefreshing(false);
    }
  }

  return (
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
          ×
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
          onClick={() => void doSync(false, false)}
          disabled={syncing || readOnly}
          title={`sync now${lockedTitle}`}
        >
          {syncing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
          sync
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void doSync(false, true)}
          disabled={syncing || readOnly}
          title={`dry-run sync${lockedTitle}`}
        >
          dry-run
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void doSync(true, false)}
          disabled={syncing || readOnly}
          title={`sync with prune (deletes resources removed from Git)${lockedTitle}`}
        >
          sync + prune
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void doRefresh(false)}
          disabled={refreshing || readOnly}
          title={`refresh (re-render manifests against cached repo)${lockedTitle}`}
        >
          {refreshing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          refresh
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void doRefresh(true)}
          disabled={refreshing || readOnly}
          title={`hard refresh (re-clone the repo)${lockedTitle}`}
        >
          hard refresh
        </Button>
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

      <ResourceList detail={detail.data} loading={detail.isLoading} />

      {detail.data?.history && detail.data.history.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
            history
          </div>
          <ul className="space-y-0.5 font-mono text-[11px]">
            {detail.data.history.slice(0, 5).map((h) => (
              <li
                key={`${h.revision}-${h.deployed_at ?? ""}`}
                className="flex items-baseline gap-2"
              >
                <span className="text-text-muted">{h.revision.slice(0, 7)}</span>
                <span className="text-text-secondary">
                  {h.deployed_at ?? ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionPanel>
  );
}

function ResourceList({
  detail,
  loading,
}: {
  detail: ArgoApplicationDetail | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-text-muted">
        <Loader2 className="size-3 animate-spin" /> loading resources…
      </div>
    );
  }
  if (!detail || detail.resources.length === 0) {
    return (
      <p className="text-[11px] text-text-muted">no managed resources yet</p>
    );
  }
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
        managed resources · {detail.resources.length}
      </div>
      <ul className="max-h-72 space-y-0.5 overflow-auto pr-1 font-mono text-[11px]">
        {detail.resources.map((r) => {
          const id = `${r.kind}/${r.namespace ?? "-"}/${r.name}`;
          return (
            <li key={id} className="flex items-center gap-2">
              <ResourceDot
                sync={r.sync_status}
                health={r.health_status}
              />
              <span className="text-text-muted">{r.kind}</span>
              <span className="text-text-primary">{r.name}</span>
              {r.namespace && (
                <span className="text-text-muted">· {r.namespace}</span>
              )}
              {r.health_message && (
                <span
                  className="ml-auto truncate text-warning"
                  title={r.health_message}
                >
                  {r.health_message}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

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
          : status === "Suspended"
            ? "border-border-default bg-elevated text-text-muted"
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
  // Health dominates color (a healthy resource that's drifted is more
  // notable than an unhealthy one that matches Git, since the unhealthy
  // case has its own message); fall back to sync when health is null.
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
      <span className="min-w-0 truncate font-mono text-text-primary" title={value}>
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
