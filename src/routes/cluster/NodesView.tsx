import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Cpu,
  Loader2,
  Lock,
  LockOpen,
  MemoryStick,
  RefreshCw,
  Server,
  ShieldOff,
  SignalZero,
} from "lucide-react";
import { toast } from "sonner";
import { k8s, type DrainSummary, type NodeSummary } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { useK8sWatch } from "@/hooks/useK8sWatch";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";

function formatBytes(n: number): string {
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function formatCpu(milli: number): string {
  if (milli < 1000) return `${milli}m`;
  return `${(milli / 1000).toFixed(2)}`;
}

function barColor(pct: number): string {
  if (pct < 50) return "bg-success/70";
  if (pct < 75) return "bg-success/80";
  if (pct < 90) return "bg-warning";
  return "bg-danger";
}

type NodeAction =
  | { kind: "cordon"; nodeName: string }
  | { kind: "uncordon"; nodeName: string }
  | { kind: "drain"; nodeName: string };

function Row({
  n,
  busy,
  onAction,
}: {
  n: NodeSummary;
  busy: boolean;
  onAction: (a: NodeAction) => void;
}) {
  const cpuPct = n.cpu_usage_milli !== null && n.cpu_allocatable_milli > 0
    ? (n.cpu_usage_milli / n.cpu_allocatable_milli) * 100
    : null;
  const memPct = n.mem_usage_bytes !== null && n.mem_allocatable_bytes > 0
    ? (n.mem_usage_bytes / n.mem_allocatable_bytes) * 100
    : null;
  return (
    <tr className="border-b border-border-subtle hover:bg-elevated">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={cn("size-2 rounded-full", n.ready ? "bg-success" : "bg-danger")}
          />
          <span className="text-[13px] text-text-primary font-medium">{n.name}</span>
          {n.unschedulable && (
            <span
              className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-[10px] text-warning font-mono"
              title="cordoned — scheduler will not place new pods here"
            >
              cordoned
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {n.roles.map((r) => (
            <span
              key={r}
              className="px-1.5 py-0.5 rounded bg-elevated border border-border-subtle text-[10px] text-text-secondary"
            >
              {r || "worker"}
            </span>
          ))}
        </div>
      </td>
      <td className="px-3 py-2.5 text-[11px] text-text-secondary font-mono">{n.version}</td>
      <td className="px-3 py-2.5 text-[11px] text-text-secondary font-mono">{n.arch}</td>
      <td className="px-3 py-2.5">
        <UsageCell
          value={cpuPct}
          label={
            n.cpu_usage_milli !== null
              ? `${formatCpu(n.cpu_usage_milli)} / ${formatCpu(n.cpu_allocatable_milli)}`
              : formatCpu(n.cpu_allocatable_milli)
          }
        />
      </td>
      <td className="px-3 py-2.5">
        <UsageCell
          value={memPct}
          label={
            n.mem_usage_bytes !== null
              ? `${formatBytes(n.mem_usage_bytes)} / ${formatBytes(n.mem_allocatable_bytes)}`
              : formatBytes(n.mem_allocatable_bytes)
          }
        />
      </td>
      <td className="px-3 py-2.5 text-[11px] text-text-secondary tabular-nums">{n.pods_capacity}</td>
      <td className="px-3 py-2.5">
        {n.taints.length === 0 ? (
          <span className="text-[11px] text-text-muted">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {n.taints.map((t) => (
              <span
                key={t}
                className="px-1.5 py-0.5 rounded bg-warning-soft border border-warning/30 text-[10px] text-warning font-mono"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1">
          {n.unschedulable ? (
            <button
              type="button"
              onClick={() => onAction({ kind: "uncordon", nodeName: n.name })}
              disabled={busy}
              title="uncordon (allow scheduling)"
              className="p-1 rounded hover:bg-elevated text-text-secondary hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <LockOpen className="size-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onAction({ kind: "cordon", nodeName: n.name })}
              disabled={busy}
              title="cordon (stop scheduling new pods)"
              className="p-1 rounded hover:bg-elevated text-text-secondary hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Lock className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onAction({ kind: "drain", nodeName: n.name })}
            disabled={busy}
            title="drain (cordon + evict workload pods)"
            className="p-1 rounded hover:bg-elevated text-text-secondary hover:text-warning disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldOff className="size-3.5" />}
          </button>
        </div>
      </td>
    </tr>
  );
}

function UsageCell({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="min-w-[160px]">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-elevated rounded-full overflow-hidden">
          <div
            className={cn("h-full", value === null ? "bg-elevated" : barColor(value))}
            style={{ width: `${value === null ? 0 : Math.min(100, Math.max(0, value))}%` }}
          />
        </div>
        <span className="text-[11px] text-text-secondary tabular-nums w-[44px] text-right">
          {value === null ? "—" : `${Math.round(value)}%`}
        </span>
      </div>
      <div className="text-[10px] text-text-muted mt-0.5 tabular-nums">{label}</div>
    </div>
  );
}

export function NodesView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const qc = useQueryClient();
  // List query supplies the metrics-server enrichment (cpu/mem usage); the
  // watch only triggers cache invalidation on Node spec/status changes so we
  // refetch with fresh metrics rather than maintaining duplicate state.
  // Metrics still need a periodic refetch since the watch never fires for
  // metric-only changes.
  const queryKey = ["k8s", "nodes", context];
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey,
    queryFn: () => k8s.listNodes(context || undefined),
    staleTime: 5_000,
    refetchInterval: 30_000,
  });
  useK8sWatch<NodeSummary>({
    queryKeys: [queryKey],
    command: "watch_nodes",
    args: { context: context || undefined },
  });
  const nodes = data ?? [];

  const [pendingAction, setPendingAction] = useState<NodeAction | null>(null);
  const [actionBusyNode, setActionBusyNode] = useState<string | null>(null);

  async function performPendingAction() {
    if (!pendingAction) return;
    const { kind, nodeName } = pendingAction;
    setActionBusyNode(nodeName);
    try {
      if (kind === "cordon") {
        await k8s.cordonNode(nodeName, context || undefined);
        toast.success(`cordoned ${nodeName}`);
      } else if (kind === "uncordon") {
        await k8s.uncordonNode(nodeName, context || undefined);
        toast.success(`uncordoned ${nodeName}`);
      } else {
        const summary: DrainSummary = await k8s.drainNode(nodeName, context || undefined);
        const parts = [`evicted ${summary.evicted}`];
        if (summary.skipped_daemonset > 0) parts.push(`skipped ${summary.skipped_daemonset} daemonset`);
        if (summary.skipped_mirror > 0) parts.push(`skipped ${summary.skipped_mirror} mirror`);
        if (summary.failed.length > 0) {
          toast.warning(
            `drained ${nodeName}: ${parts.join(", ")} · ${summary.failed.length} failed (likely PDB-blocked)`,
          );
        } else {
          toast.success(`drained ${nodeName}: ${parts.join(", ")}`);
        }
      }
      setPendingAction(null);
      await qc.invalidateQueries({ queryKey });
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setActionBusyNode(null);
    }
  }
  const metricsUnavailable =
    nodes.length > 0 &&
    nodes.every((node) => node.cpu_usage_milli === null && node.mem_usage_bytes === null);

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-app/95 backdrop-blur border-b border-border-subtle flex items-center justify-between px-6 py-4">
        <div>
          <h1 className="mds-heading text-[20px] text-text-primary flex items-center gap-2">
            <Server className="size-5" /> nodes
          </h1>
          <p className="text-[12px] text-text-secondary">
            {context} · {data?.length ?? 0} node{data?.length === 1 ? "" : "s"}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
          disabled={isFetching}
        >
          <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} /> refresh
        </button>
      </div>
      <div className="p-6">
        {error ? (
          <div className="rounded-panel border border-danger/30 bg-[var(--status-error-soft)] p-4 text-[13px] text-danger">
            {(error as Error).message}
          </div>
        ) : isLoading ? (
          <div className="text-[13px] text-text-secondary">loading nodes...</div>
        ) : nodes.length === 0 ? (
          <div className="text-[13px] text-text-secondary">no nodes found.</div>
        ) : (
          <>
            {metricsUnavailable ? (
              <div className="mb-3 flex items-start gap-2 rounded-panel border border-warning/30 bg-warning-soft px-3 py-2 text-[12px] text-warning">
                <SignalZero className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  metrics-server is unavailable; showing allocatable capacity only.
                </span>
              </div>
            ) : null}
            <div className="rounded-panel border border-border-subtle overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-shell">
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-text-muted">
                      node
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-text-muted">
                      version
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-text-muted">
                      arch
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-text-muted">
                      <Cpu className="size-3 inline mr-1" />
                      cpu
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-text-muted">
                      <MemoryStick className="size-3 inline mr-1" />
                      mem
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-text-muted">
                      pods
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-text-muted">
                      taints
                    </th>
                    <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-text-muted">
                      actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((n) => (
                    <Row
                      key={n.name}
                      n={n}
                      busy={actionBusyNode === n.name}
                      onAction={setPendingAction}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {pendingAction && (
        <ConfirmActionDialog
          open
          title={
            pendingAction.kind === "cordon"
              ? "cordon node"
              : pendingAction.kind === "uncordon"
                ? "uncordon node"
                : "drain node"
          }
          description={
            pendingAction.kind === "cordon"
              ? `This marks ${pendingAction.nodeName} unschedulable. Existing pods stay running; new pods will be placed on other nodes.`
              : pendingAction.kind === "uncordon"
                ? `This clears the unschedulable flag on ${pendingAction.nodeName}. The scheduler will resume placing pods here.`
                : `This cordons ${pendingAction.nodeName} and evicts every workload pod scheduled on it. DaemonSet and mirror pods are skipped. Pods blocked by a PodDisruptionBudget are reported back rather than force-deleted.`
          }
          target={pendingAction.nodeName}
          confirmLabel={pendingAction.kind}
          intent={pendingAction.kind === "drain" ? "danger" : "warning"}
          busy={actionBusyNode === pendingAction.nodeName}
          onCancel={() => setPendingAction(null)}
          onConfirm={performPendingAction}
        />
      )}
    </div>
  );
}
