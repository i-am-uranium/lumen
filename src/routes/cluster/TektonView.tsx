import { useMutationCapability } from "@/hooks/useMutationCapability";
import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldQuestion,
  Workflow,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  k8s,
  type TektonPipelineRunSummary,
  type TektonRunStatus,
  type TektonTaskRunStatus,
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

/**
 * Tekton PipelineRuns view.
 *
 * Master/detail layout with multi-select status filtering and a single
 * mutator (cancel) that patches `.spec.status: "Cancelled"` on the
 * PipelineRun CRD. The detail panel polls every 5s while open so a
 * running run shows live progression; the list polls every 15s.
 *
 * The route renders even when Tekton isn't installed — the empty-state
 * branch links to the install docs so users who arrive via Cmd-K aren't
 * dead-ended.
 */

const STATUSES: readonly TektonRunStatus[] = [
  "Running",
  "Succeeded",
  "Failed",
  "Cancelled",
  "Pending",
] as const;

export function TektonView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const qc = useQueryClient();
  const readOnly = !useMutationCapability(context).canMutate;

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedKey = searchParams.get("run") ?? null;
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<TektonRunStatus>>(
    new Set(),
  );
  const [namespaceFilter, setNamespaceFilter] = useState<string>("");

  // Detection drives the empty-state when Tekton is missing — the route
  // is still mounted (Cmd-K can navigate here unconditionally).
  const installed = useQuery({
    queryKey: ["tekton", "available", context],
    queryFn: () => k8s.detectTekton(context || undefined),
    staleTime: 60 * 60 * 1000,
    enabled: !!context,
  });

  const runs = useQuery({
    queryKey: ["tekton", "runs", context],
    queryFn: () => k8s.listPipelineRuns(context || undefined),
    staleTime: 5_000,
    refetchInterval: 15_000,
    enabled: !!context && installed.data === true,
  });

  const namespaces = useMemo(() => {
    const set = new Set<string>();
    for (const r of runs.data ?? []) set.add(r.namespace);
    return Array.from(set).sort();
  }, [runs.data]);

  const filteredRuns = useMemo(() => {
    let list = runs.data ?? [];
    if (filter.trim()) {
      const f = filter.toLowerCase();
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(f) ||
          r.namespace.toLowerCase().includes(f) ||
          (r.pipeline_ref?.toLowerCase().includes(f) ?? false),
      );
    }
    if (statusFilter.size > 0) {
      list = list.filter((r) =>
        statusFilter.has(r.status as TektonRunStatus),
      );
    }
    if (namespaceFilter) {
      list = list.filter((r) => r.namespace === namespaceFilter);
    }
    return list;
  }, [runs.data, filter, statusFilter, namespaceFilter]);

  const counts = useMemo(() => {
    const status = new Map<string, number>();
    for (const r of runs.data ?? []) {
      status.set(r.status, (status.get(r.status) ?? 0) + 1);
    }
    return { status };
  }, [runs.data]);

  const selected = useMemo(() => {
    if (!selectedKey) return null;
    return (runs.data ?? []).find(
      (r) => `${r.namespace}/${r.name}` === selectedKey,
    );
  }, [runs.data, selectedKey]);

  function selectRun(run: TektonPipelineRunSummary | null) {
    const next = new URLSearchParams(searchParams);
    if (run) {
      next.set("run", `${run.namespace}/${run.name}`);
    } else {
      next.delete("run");
    }
    setSearchParams(next, { replace: true });
  }

  const totalActiveFilters =
    statusFilter.size + (namespaceFilter ? 1 : 0) + (filter.trim() ? 1 : 0);

  // ── Empty state when Tekton isn't installed ─────────────────────────────
  if (installed.isFetched && installed.data === false) {
    return (
      <LumenPage>
        <PageHeader
          eyebrow="tekton"
          title="Pipeline Runs"
          icon={<Workflow className="size-4" />}
        />
        <SectionPanel>
          <div className="flex flex-col items-start gap-2 py-2">
            <p className="text-[13px] text-text-primary">
              Tekton isn't installed in this cluster.
            </p>
            <p className="text-[12px] text-text-muted">
              Tekton ships its PipelineRun and TaskRun resources as CRDs
              under <code className="font-mono">tekton.dev</code>. Install
              Tekton Pipelines on the cluster to see runs here.
            </p>
            <a
              href="https://tekton.dev/docs/installation/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[12px] text-accent-primary hover:underline"
            >
              Tekton installation docs
              <ExternalLink className="size-3" />
            </a>
          </div>
        </SectionPanel>
      </LumenPage>
    );
  }

  return (
    <LumenPage>
      <PageHeader
        eyebrow="tekton"
        title="Pipeline Runs"
        description="Tekton PipelineRuns reconciled by the in-cluster controller. Cancel writes directly to the CRD via .spec.status."
        icon={<Workflow className="size-4" />}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => runs.refetch()}
            disabled={runs.isFetching}
          >
            <RefreshCw
              className={cn("size-3.5", runs.isFetching && "animate-spin")}
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
            placeholder="filter by name / namespace / pipeline"
            className="h-8 w-72"
          />
          <FilterChipGroup
            label="status"
            options={STATUSES}
            selected={statusFilter}
            counts={counts.status}
            onToggle={(v) => setStatusFilter((prev) => toggleSet(prev, v))}
          />
          {namespaces.length > 1 && (
            <select
              value={namespaceFilter}
              onChange={(e) => setNamespaceFilter(e.target.value)}
              className="h-8 rounded-control border border-border-default bg-elevated px-2 text-[11px] text-text-primary"
              title="filter by namespace"
            >
              <option value="">namespace: any</option>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  namespace: {ns}
                </option>
              ))}
            </select>
          )}
          {totalActiveFilters > 0 && (
            <button
              type="button"
              onClick={() => {
                setFilter("");
                setStatusFilter(new Set());
                setNamespaceFilter("");
              }}
              className="text-[11px] text-text-muted hover:text-text-primary"
            >
              clear filters
            </button>
          )}
          <span className="ml-auto text-[11px] text-text-muted tabular-nums">
            {filteredRuns.length} of {runs.data?.length ?? 0}
          </span>
        </div>
      </SectionPanel>

      {runs.error ? (
        <SectionPanel className="border border-danger/30 bg-[var(--status-error-soft)]">
          <p className="text-[12px] text-danger">
            {(runs.error as Error).message ?? "failed to fetch pipeline runs"}
          </p>
        </SectionPanel>
      ) : runs.isLoading || installed.isLoading ? (
        <SectionPanel>
          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            <Loader2 className="size-3.5 animate-spin" /> loading pipeline runs…
          </div>
        </SectionPanel>
      ) : (runs.data ?? []).length === 0 ? (
        <SectionPanel>
          <p className="text-[12px] text-text-muted">
            No PipelineRuns yet. Tekton CRDs are registered but no runs have
            been triggered.
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
                    <Th>pipeline</Th>
                    <Th>status</Th>
                    <Th>tasks</Th>
                    <Th>duration</Th>
                    <Th>age</Th>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {filteredRuns.map((r) => {
                    const key = `${r.namespace}/${r.name}`;
                    const active = selectedKey === key;
                    return (
                      <DataTableRow
                        key={key}
                        onClick={() => selectRun(r)}
                        className={cn(
                          "cursor-pointer",
                          active && "bg-accent-primary-soft",
                        )}
                      >
                        <DataTableCell className="px-4">
                          <span className="text-[13px] font-medium text-text-primary">
                            {r.name}
                          </span>
                        </DataTableCell>
                        <DataTableCell mono className="text-[11px]">
                          {r.namespace}
                        </DataTableCell>
                        <DataTableCell mono className="text-[11px]">
                          {r.pipeline_ref ?? <em>inline</em>}
                        </DataTableCell>
                        <DataTableCell>
                          <StatusPill status={r.status} />
                        </DataTableCell>
                        <DataTableCell mono className="text-[11px] tabular-nums">
                          {r.task_count}
                        </DataTableCell>
                        <DataTableCell mono className="text-[11px] tabular-nums">
                          {formatDuration(r.duration_seconds)}
                        </DataTableCell>
                        <DataTableCell mono className="text-[11px]">
                          {formatAge(r.age_seconds)}
                        </DataTableCell>
                      </DataTableRow>
                    );
                  })}
                </DataTableBody>
              </DataTable>
            </DataTableShell>
            {filteredRuns.length === 0 && (
              <p className="px-4 py-3 text-[11px] text-text-muted">
                No pipeline runs match the current filters.
              </p>
            )}
          </SectionPanel>

          {selected ? (
            <PipelineRunDetailPanel
              context={context}
              run={selected}
              readOnly={readOnly}
              onClose={() => selectRun(null)}
              onMutated={() => {
                qc.invalidateQueries({
                  queryKey: ["tekton", "runs", context],
                });
                qc.invalidateQueries({
                  queryKey: [
                    "tekton",
                    "run",
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
                Select a pipeline run to see its tasks, params, and conditions.
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

function PipelineRunDetailPanel({
  context,
  run,
  readOnly,
  onClose,
  onMutated,
}: {
  context: string;
  run: TektonPipelineRunSummary;
  readOnly: boolean;
  onClose: () => void;
  onMutated: () => void;
}) {
  const detail = useQuery({
    queryKey: ["tekton", "run", context, run.namespace, run.name],
    queryFn: () =>
      k8s.getPipelineRun(context || undefined, run.namespace, run.name),
    staleTime: 1_000,
    refetchInterval: 5_000,
  });
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const lockedTitle = readOnly ? " (changes blocked)" : "";
  // Cancel only makes sense for runs the controller is still
  // reconciling. Pending counts as "running" here too — the user may
  // want to cancel before any TaskRun fires up.
  const cancellable = run.status === "Running" || run.status === "Pending";

  async function performCancel() {
    setBusy(true);
    try {
      await k8s.cancelPipelineRun(
        context || undefined,
        run.namespace,
        run.name,
      );
      toast.success(`cancel requested for ${run.name}`);
      onMutated();
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
      setConfirmCancel(false);
    }
  }

  return (
    <SectionPanel className="self-start">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="mds-heading text-[14px] text-text-primary truncate">
            {run.name}
          </h2>
          <p className="font-mono text-[11px] text-text-muted">
            {run.namespace}
            {run.pipeline_ref ? ` · ${run.pipeline_ref}` : " · inline"}
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
        <StatusPill status={run.status} />
        <span className="rounded border border-border-default bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
          {formatDuration(run.duration_seconds)}
        </span>
        <span className="rounded border border-border-default bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
          age {formatAge(run.age_seconds)}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {cancellable && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmCancel(true)}
            disabled={busy || readOnly}
            title={`cancel pipeline run${lockedTitle}`}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CircleStop className="size-3.5" />
            )}
            cancel
          </Button>
        )}
      </div>

      <ParamsAndWorkspaces
        params={detail.data?.params}
        workspaces={detail.data?.workspaces}
        loading={detail.isLoading}
      />

      <TasksList
        tasks={detail.data?.tasks}
        loading={detail.isLoading}
        truncated={detail.data?.tasks_truncated ?? false}
        totalTaskCount={run.task_count}
      />

      {detail.data?.conditions && detail.data.conditions.length > 0 && (
        <ConditionsList conditions={detail.data.conditions} />
      )}

      <ConfirmActionDialog
        context={context}
        open={confirmCancel}
        title="cancel pipeline run"
        description={`This patches .spec.status to "Cancelled" on ${run.name}. Tekton stops scheduling new TaskRuns and signals running pods to terminate. TaskRuns that have already completed are not affected.`}
        target={`${run.namespace}/${run.name}`}
        confirmLabel="cancel run"
        intent="warning"
        busy={busy || readOnly}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={performCancel}
      />
    </SectionPanel>
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

// ─── Detail subviews ──────────────────────────────────────────────────────

function ParamsAndWorkspaces({
  params,
  workspaces,
  loading,
}: {
  params: [string, string][] | undefined;
  workspaces: string[] | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="mb-3 flex items-center gap-2 text-[11px] text-text-muted">
        <Loader2 className="size-3 animate-spin" /> loading params…
      </div>
    );
  }
  const hasParams = params && params.length > 0;
  const hasWorkspaces = workspaces && workspaces.length > 0;
  if (!hasParams && !hasWorkspaces) return null;
  return (
    <div className="mb-4 grid grid-cols-1 gap-1.5 text-[11px]">
      {hasParams && (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-text-muted">
            params · {params.length}
          </div>
          <ul className="font-mono">
            {params.map(([k, v]) => (
              <li
                key={k}
                className="flex items-baseline gap-2 truncate"
                title={`${k} = ${v}`}
              >
                <span className="text-text-muted">{k}</span>
                <span className="truncate text-text-primary">{v}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {hasWorkspaces && (
        <div>
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-text-muted">
            workspaces · {workspaces.length}
          </div>
          <ul className="font-mono">
            {workspaces.map((w) => (
              <li key={w} className="text-text-primary">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TasksList({
  tasks,
  loading,
  truncated,
  totalTaskCount,
}: {
  tasks: TektonTaskRunStatus[] | undefined;
  loading: boolean;
  truncated: boolean;
  totalTaskCount: number;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-text-muted">
        <Loader2 className="size-3 animate-spin" /> loading tasks…
      </div>
    );
  }
  if (!tasks || tasks.length === 0) {
    return (
      <p className="text-[11px] text-text-muted">no task runs scheduled yet</p>
    );
  }
  return (
    <div className="mb-2">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
        tasks · {tasks.length}
        {truncated && totalTaskCount > tasks.length && (
          <span className="ml-1 normal-case tracking-normal text-warning">
            (showing first {tasks.length} of {totalTaskCount})
          </span>
        )}
      </div>
      <ul className="max-h-72 space-y-0.5 overflow-auto pr-1 font-mono text-[11px]">
        {tasks.map((t) => (
          <li
            key={t.name}
            className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-elevated"
            title={t.message ?? undefined}
          >
            <StatusDot status={t.status} />
            <span className="text-text-primary">
              {t.display_name ?? t.name}
            </span>
            {t.display_name && t.display_name !== t.name && (
              <span className="text-text-muted">· {t.name}</span>
            )}
            <span className="ml-auto tabular-nums text-text-muted">
              {formatDuration(t.duration_seconds)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConditionsList({
  conditions,
}: {
  conditions: { type: string; status: string; reason: string | null; message: string | null }[];
}) {
  return (
    <div className="mt-4">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-text-muted">
        conditions
      </div>
      <ul className="space-y-0.5 font-mono text-[11px]">
        {conditions.map((c, idx) => (
          <li
            key={`${c.type}-${idx}`}
            className="flex items-baseline gap-2"
            title={c.message ?? undefined}
          >
            <span className="text-text-muted">{c.type}</span>
            <span
              className={cn(
                c.status === "True"
                  ? "text-success"
                  : c.status === "False"
                    ? "text-danger"
                    : "text-text-secondary",
              )}
            >
              {c.status}
            </span>
            {c.reason && (
              <span className="text-text-muted">· {c.reason}</span>
            )}
            {c.message && (
              <span className="truncate text-text-secondary">{c.message}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Pills + helpers ──────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "Succeeded"
      ? "border-success/40 bg-success-soft text-success"
      : status === "Running"
        ? "border-info/40 bg-info-soft text-info"
        : status === "Failed"
          ? "border-danger/40 bg-danger-soft text-danger"
          : status === "Cancelled"
            ? "border-warning/40 bg-warning-soft text-warning"
            : "border-border-default bg-elevated text-text-muted";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase",
        cls,
      )}
    >
      {status === "Succeeded" ? (
        <CheckCircle2 className="size-3" />
      ) : status === "Running" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : status === "Failed" ? (
        <AlertTriangle className="size-3" />
      ) : status === "Cancelled" ? (
        <CircleStop className="size-3" />
      ) : (
        <ShieldQuestion className="size-3" />
      )}
      {status}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "Succeeded"
      ? "bg-success"
      : status === "Running"
        ? "bg-info"
        : status === "Failed"
          ? "bg-danger"
          : status === "Cancelled"
            ? "bg-warning"
            : "bg-border-subtle";
  return <span className={cn("size-1.5 shrink-0 rounded-full", color)} />;
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <DataTableHead className="whitespace-nowrap text-[10px]">
      {children}
    </DataTableHead>
  );
}

// ─── Number formatting (local — no shared helper exists yet) ──────────────

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
