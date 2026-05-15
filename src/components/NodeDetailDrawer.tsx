import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Box,
  Cpu,
  Loader2,
  MemoryStick,
  RefreshCw,
  Server,
  X,
} from "lucide-react";
import {
  DrawerBackdrop,
  DrawerHeader,
  DrawerPanel,
  DrawerResizeHandle,
} from "@/components/lumen/drawer";
import { CopyableName } from "@/components/lumen/copyable-name";
import { k8s, type NodeSummary, type WorkloadSummary } from "@/lib/k8s";
import { useShortcut } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

// ─── Lumen distinct touches vs Lens ────────────────────────────────────
//   • Reuses the side-docked drawer chrome from ResourceDetailDrawer so
//     the table behind stays in view.
//   • Compact property grid with ASCII dividers and lowercase headings,
//     matching the rest of Lumen.
//   • Pod list is colocated in the same panel rather than a pop-out — the
//     interesting question for an operator is usually "what's running
//     here?" alongside "is the node healthy?", so we put both in one place.

function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function formatCpu(milli: number | null | undefined): string {
  if (milli === null || milli === undefined || !Number.isFinite(milli)) return "—";
  if (milli < 1000) return `${milli}m`;
  return `${(milli / 1000).toFixed(2)}`;
}

function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function barColor(pct: number): string {
  if (pct < 50) return "bg-success/70";
  if (pct < 75) return "bg-success/80";
  if (pct < 90) return "bg-warning";
  return "bg-danger";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function UsageBar({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="min-w-[180px]">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-elevated rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full",
              value === null ? "bg-elevated" : barColor(value),
            )}
            style={{
              width: `${value === null ? 0 : Math.min(100, Math.max(0, value))}%`,
            }}
          />
        </div>
        <span className="text-[11px] text-text-secondary tabular-nums w-[44px] text-right">
          {value === null ? "—" : `${Math.round(value)}%`}
        </span>
      </div>
      <div className="text-[10px] text-text-muted mt-0.5 tabular-nums">
        {label}
      </div>
    </div>
  );
}

function PropertyRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-1.5 border-b border-border-subtle last:border-b-0">
      <div className="text-[11px] uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div className="text-[12px] text-text-primary min-w-0">{value}</div>
    </div>
  );
}

function podPhaseColor(phase: string | undefined): string {
  switch (phase) {
    case "Running":
    case "Succeeded":
      return "text-success";
    case "Pending":
      return "text-warning";
    case "Failed":
      return "text-danger";
    default:
      return "text-text-secondary";
  }
}

export function NodeDetailDrawer({
  ctx,
  node,
  onClose,
}: {
  ctx: string;
  node: NodeSummary | null;
  onClose: () => void;
}) {
  const open = node !== null;
  useShortcut("drawerClose", () => onClose(), { enabled: open });

  // Same resize / persistence model as ResourceDetailDrawer so users get a
  // consistent drawer width across the app.
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 620;
    const saved = window.localStorage.getItem("lumen:drawer:width");
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 360 ? parsed : 620;
  });
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let last = startW;
    const onMove = (ev: PointerEvent) => {
      const next = clamp(
        startW + (startX - ev.clientX),
        360,
        window.innerWidth * 0.85,
      );
      last = next;
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.localStorage.setItem("lumen:drawer:width", String(Math.round(last)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const pods = useQuery({
    queryKey: ["k8s", "pods-on-node", ctx, node?.name],
    queryFn: () => k8s.listPodsOnNode(node!.name, ctx || undefined),
    enabled: open,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const cpuPct = useMemo(() => {
    if (!node || node.cpu_usage_milli === null) return null;
    if (node.cpu_allocatable_milli <= 0) return null;
    return (node.cpu_usage_milli / node.cpu_allocatable_milli) * 100;
  }, [node]);
  const memPct = useMemo(() => {
    if (!node || node.mem_usage_bytes === null) return null;
    if (node.mem_allocatable_bytes <= 0) return null;
    return (node.mem_usage_bytes / node.mem_allocatable_bytes) * 100;
  }, [node]);

  if (!open || !node) return null;

  const titleId = `node-drawer-title-${node.name}`;
  const podList: WorkloadSummary[] = pods.data ?? [];
  // node.pods_capacity is the kubelet-advertised capacity (e.g. 110 on
  // most managed clusters); show it next to the live count so an operator
  // can spot a node sitting at saturation.
  const podCapacity = node.pods_capacity;

  return (
    <>
      <DrawerBackdrop onClick={onClose} />
      <DrawerPanel width={width} role="dialog" aria-labelledby={titleId}>
        <DrawerResizeHandle onPointerDown={startResize} />
        <DrawerHeader>
          <Server className="size-4 text-text-secondary" />
          <div className="min-w-0 flex-1">
            <CopyableName
              value={node.name}
              className="px-1 -mx-1 py-0.5 min-w-0"
            >
              <h2
                id={titleId}
                className="mds-heading truncate text-[14px] text-text-primary"
              >
                {node.name}
              </h2>
            </CopyableName>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-text-secondary">
              <span
                className={cn(
                  "inline-flex items-center gap-1",
                  node.ready ? "text-success" : "text-danger",
                )}
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    node.ready ? "bg-success" : "bg-danger",
                  )}
                />
                {node.ready ? "ready" : "not ready"}
              </span>
              {node.unschedulable && (
                <span
                  className="px-1.5 py-0.5 rounded bg-warning-soft border border-warning/30 text-[10px] text-warning font-mono"
                  title="cordoned — scheduler will not place new pods here"
                >
                  cordoned
                </span>
              )}
              <span className="text-text-muted">·</span>
              <span className="font-mono">{node.version}</span>
              <span className="text-text-muted">·</span>
              <span className="font-mono">{node.arch}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => pods.refetch()}
            className="inline-flex size-7 items-center justify-center rounded text-text-secondary hover:bg-elevated hover:text-text-primary"
            title="refresh pods"
            disabled={pods.isFetching}
          >
            <RefreshCw
              className={cn("size-3.5", pods.isFetching && "animate-spin")}
            />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-7 items-center justify-center rounded text-text-secondary hover:bg-elevated hover:text-text-primary"
            title="close (esc)"
            aria-label="Close drawer"
          >
            <X className="size-4" />
          </button>
        </DrawerHeader>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* ─── Properties ─────────────────────────────────────────── */}
          <section className="px-4 py-3">
            <h3 className="mb-2 text-[10px] uppercase tracking-wider text-text-muted">
              properties
            </h3>
            <PropertyRow
              label="roles"
              value={
                node.roles.length === 0 ? (
                  <span className="text-text-muted">worker</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {node.roles.map((r) => (
                      <span
                        key={r}
                        className="px-1.5 py-0.5 rounded bg-elevated border border-border-subtle text-[10px] text-text-secondary"
                      >
                        {r || "worker"}
                      </span>
                    ))}
                  </div>
                )
              }
            />
            <PropertyRow
              label="os image"
              value={
                <span className="font-mono text-[11px] text-text-secondary break-all">
                  {node.os_image || "—"}
                </span>
              }
            />
            <PropertyRow
              label="age"
              value={
                <span className="font-mono text-text-secondary">
                  {formatAge(node.age_seconds)}
                </span>
              }
            />
            <PropertyRow
              label="cpu"
              value={
                <div className="flex items-center gap-3">
                  <Cpu className="size-3 text-text-muted" />
                  <UsageBar
                    value={cpuPct}
                    label={
                      node.cpu_usage_milli !== null
                        ? `${formatCpu(node.cpu_usage_milli)} / ${formatCpu(node.cpu_allocatable_milli)}`
                        : `allocatable ${formatCpu(node.cpu_allocatable_milli)}`
                    }
                  />
                </div>
              }
            />
            <PropertyRow
              label="memory"
              value={
                <div className="flex items-center gap-3">
                  <MemoryStick className="size-3 text-text-muted" />
                  <UsageBar
                    value={memPct}
                    label={
                      node.mem_usage_bytes !== null
                        ? `${formatBytes(node.mem_usage_bytes)} / ${formatBytes(node.mem_allocatable_bytes)}`
                        : `allocatable ${formatBytes(node.mem_allocatable_bytes)}`
                    }
                  />
                </div>
              }
            />
            <PropertyRow
              label="pods"
              value={
                <span className="font-mono text-text-secondary tabular-nums">
                  {pods.isLoading ? "…" : podList.length} / {podCapacity}
                </span>
              }
            />
            <PropertyRow
              label="taints"
              value={
                node.taints.length === 0 ? (
                  <span className="text-text-muted">none</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {node.taints.map((t) => (
                      <span
                        key={t}
                        className="px-1.5 py-0.5 rounded bg-warning-soft border border-warning/30 text-[10px] text-warning font-mono"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )
              }
            />
          </section>

          {/* ─── Pods on this node ─────────────────────────────────── */}
          <section className="px-4 py-3 border-t border-border-default">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[10px] uppercase tracking-wider text-text-muted flex items-center gap-1.5">
                <Box className="size-3" /> pods on this node
              </h3>
              <span className="text-[11px] text-text-secondary tabular-nums">
                {pods.isLoading ? "loading…" : `${podList.length} pod${podList.length === 1 ? "" : "s"}`}
              </span>
            </div>
            {pods.error ? (
              <div className="rounded-panel border border-danger/30 bg-[var(--status-error-soft)] p-3 text-[12px] text-danger">
                {(pods.error as Error).message}
              </div>
            ) : pods.isLoading ? (
              <div className="flex items-center gap-2 text-[12px] text-text-secondary py-3">
                <Loader2 className="size-3.5 animate-spin" /> fetching pods…
              </div>
            ) : podList.length === 0 ? (
              <div className="text-[12px] text-text-muted py-3">
                no pods scheduled on this node.
              </div>
            ) : (
              <div className="rounded-panel border border-border-subtle overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="bg-shell">
                      <th className="text-left px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
                        pod
                      </th>
                      <th className="text-left px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
                        namespace
                      </th>
                      <th className="text-left px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
                        status
                      </th>
                      <th className="text-right px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
                        ready
                      </th>
                      <th className="text-right px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
                        restarts
                      </th>
                      <th className="text-right px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
                        cpu
                      </th>
                      <th className="text-right px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-text-muted">
                        memory
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {podList.map((p) => (
                      <tr
                        key={`${p.namespace}/${p.name}`}
                        className="border-b border-border-subtle last:border-b-0 hover:bg-elevated"
                      >
                        <td className="px-2.5 py-1.5 text-[12px] text-text-primary font-mono truncate max-w-[220px]">
                          {p.name}
                        </td>
                        <td className="px-2.5 py-1.5 text-[11px] text-text-secondary font-mono">
                          {p.namespace}
                        </td>
                        <td
                          className={cn(
                            "px-2.5 py-1.5 text-[11px] font-mono",
                            podPhaseColor(p.pod_phase),
                          )}
                        >
                          {p.pod_phase ?? "—"}
                        </td>
                        <td className="px-2.5 py-1.5 text-[11px] text-text-secondary font-mono text-right tabular-nums">
                          {p.ready}
                        </td>
                        <td className="px-2.5 py-1.5 text-[11px] text-text-secondary font-mono text-right tabular-nums">
                          {p.restart_count ?? 0}
                        </td>
                        <td className="px-2.5 py-1.5 text-[11px] text-text-secondary font-mono text-right tabular-nums">
                          {formatCpu(p.cpu_milli ?? null)}
                        </td>
                        <td className="px-2.5 py-1.5 text-[11px] text-text-secondary font-mono text-right tabular-nums">
                          {formatBytes(p.mem_bytes ?? null)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </DrawerPanel>
    </>
  );
}
