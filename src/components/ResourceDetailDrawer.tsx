import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, Channel } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Download,
  Loader2,
  Pencil,
  ScrollText,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PinButton } from "@/components/PinButton";
import { LogsViewer } from "./logs/LogsViewer";
import { useShellDock } from "@/hooks/useShellDock";
import { k8s, type ContainerInfo, type WorkloadKind } from "@/lib/k8s";
import { cn } from "@/lib/utils";

// ─── Lumen-distinct touches vs Lens ────────────────────────────────────
//   • Side-docked panel (not floating modal); main view stays visible.
//   • 3px severity strip at the top reflects pod health at a glance.
//   • Container chiclets: thin colored pills with restart-count badges.
//   • Terminal aesthetic: ASCII dividers, lowercase headings, monospace
//     numerics, dense spacing.
//   • Keyboard hotkeys when drawer is open: L=logs, S=shell, D=download,
//     Y=yaml, Esc=close.

type Resource = { kind: string; namespace: string; name: string };
type DrawerTab = "overview" | "logs" | "events" | "yaml";

export function ResourceDetailDrawer({
  ctx,
  resource,
  onClose,
}: {
  ctx: string;
  resource: Resource | null;
  onClose: () => void;
}) {
  const open = resource !== null;
  const isPod = resource?.kind === "pod";
  const showLogsTab = isPod || ["deployment", "statefulset", "daemonset", "replicaset", "job"].includes(resource?.kind ?? "");
  const [activeTab, setActiveTab] = useState<DrawerTab>("overview");
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { openSession } = useShellDock();
  const qc = useQueryClient();

  // Pre-load pod-details so the Shell action can pick a default container
  // synchronously. SeverityStrip already runs the same query, so this is a
  // cache hit in practice.
  const podDetails = useQuery({
    queryKey: ["k8s", "pod-details", ctx, resource?.namespace, resource?.name],
    queryFn: () => k8s.getPodDetails(ctx, resource!.namespace, resource!.name),
    enabled: isPod && !!resource,
    staleTime: 10_000,
  });

  function openShell() {
    if (!resource || !isPod) return;
    const defaultContainer = podDetails.data?.containers[0]?.name ?? "";
    openSession({
      pod: resource.name,
      namespace: resource.namespace,
      context: ctx,
      container: defaultContainer,
      command: ["/bin/sh"],
    });
  }

  // Reset when drawer opens for a new resource.
  useEffect(() => {
    if (resource) setActiveTab("overview");
  }, [resource?.kind, resource?.namespace, resource?.name]);

  // Hotkeys (only when drawer is open).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case "escape":
          onClose();
          break;
        case "l":
          if (isPod) handleViewLogs();
          break;
        case "s":
          if (isPod) openShell();
          break;
        case "d":
          if (isPod) handleDownloadLogs();
          break;
        case "y":
          setActiveTab("yaml");
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isPod, resource]);

  // Lumen-distinct: clicking "view logs" stays in-context — switch the
  // drawer to the Logs tab (which streams inline) instead of navigating
  // away. The dedicated /cluster/:ctx/logs route is still reachable via
  // the small "open in full view" link inside the Logs tab.
  function handleViewLogs() {
    if (!resource) return;
    setActiveTab("logs");
  }

  async function handleDelete() {
    if (!resource || deleting) return;
    const ok = window.confirm(
      `Delete ${resource.kind}/${resource.name} from ${resource.namespace || "cluster scope"} in ${ctx}?`,
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await k8s.deleteResource(
        resource.namespace,
        resource.kind as WorkloadKind,
        resource.name,
        ctx,
      );
      toast.success(`deleted ${resource.kind}/${resource.name}`);
      await qc.invalidateQueries({ queryKey: ["k8s", "workloads"] });
      await qc.invalidateQueries({ queryKey: ["k8s", "resource-meta"] });
      onClose();
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setDeleting(false);
    }
  }

  async function handleDownloadLogs() {
    if (!resource || downloading) return;
    setDownloading(true);
    try {
      const channel = new Channel<{
        pod: string;
        container: string;
        text: string;
      }>();
      const lines: string[] = [];
      channel.onmessage = (msg) => {
        if (msg.text) lines.push(msg.text);
      };
      const streamId = `download-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await invoke("stream_logs", {
        selector: {
          namespace: resource.namespace,
          label_selector: null,
          pod_name: resource.name,
          container: null,
          since_seconds: null,
          tail_lines: 5000,
        },
        streamId,
        channel,
        context: ctx || undefined,
      });
      // Backend follows logs; for a tail-only download we give the channel
      // a window to flush the historical 5000 lines, then stop.
      await new Promise((r) => setTimeout(r, 2000));
      await invoke("stop_stream", { streamId }).catch(() => {});
      const blob = new Blob([lines.join("\n")], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${resource.namespace}-${resource.name}.log`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  // ─── Resizable width (Lumen polish) ─────────────────────────────────
  // Drag the left edge to resize. Width is persisted per-user in
  // localStorage. Min 360px (any narrower and the property labels
  // collide), max 80% of viewport so the underlying table stays usable.
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 560;
    const saved = window.localStorage.getItem("lumen:drawer:width");
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 360 ? parsed : 560;
  });
  const dragRef = useState<{ x0: number; w0: number } | null>(null);
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => {
      const next = clamp(startW + (startX - ev.clientX), 360, window.innerWidth * 0.8);
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.localStorage.setItem(
        "lumen:drawer:width",
        String(Math.round(width)),
      );
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    void dragRef;
  }

  if (!open) return null;
  const titleId = `resource-drawer-title-${resource.kind}-${resource.namespace}-${resource.name}`;

  return (
    <>
      {/* Backdrop — softer than a full-screen modal so the table behind stays
          visible. Clickable to dismiss. */}
      <div
        className="fixed inset-0 z-40 bg-black/30 transition-opacity duration-150"
        onClick={onClose}
      />
      {/* Side-docked panel */}
      <aside
        className={cn(
          "fixed top-0 right-0 z-50 h-full max-w-[100vw]",
          "bg-term-panel border-l border-term-border-soft",
          "flex flex-col",
          "transition-transform duration-200 ease-out",
          "translate-x-0",
        )}
        style={{ width }}
        role="dialog"
        aria-labelledby={titleId}
      >
        {/* Resize handle — invisible 4px strip on the left edge that grows
            into a 1px term-green line on hover/drag. Lumen-distinct: keeps
            the chrome minimal until interacted with. */}
        <div
          onPointerDown={startResize}
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10 group"
          title="drag to resize"
        >
          <div className="absolute inset-y-0 left-0 w-px bg-transparent group-hover:bg-term-green/60 transition-colors" />
        </div>
        <SeverityStrip resource={resource} ctx={ctx} />
        <Header
          titleId={titleId}
          ctx={ctx}
          resource={resource}
          isPod={isPod}
          downloading={downloading}
          onViewLogs={handleViewLogs}
          onDownloadLogs={handleDownloadLogs}
          onShellExec={openShell}
          onEditYaml={() => setActiveTab("yaml")}
          deleting={deleting}
          onDelete={handleDelete}
          onClose={onClose}
        />
        <Tabs activeTab={activeTab} onChange={setActiveTab} showLogsTab={showLogsTab} />
        <div className="flex-1 min-h-0 overflow-y-auto">
          {activeTab === "overview" && (
            <PropertiesTab ctx={ctx} resource={resource!} isPod={isPod} />
          )}
          {activeTab === "yaml" && <YamlTab ctx={ctx} resource={resource!} />}
          {activeTab === "events" && <EventsTab ctx={ctx} resource={resource!} />}
          {activeTab === "logs" && resource && (
            <LogsViewer
              ctx={ctx}
              namespace={resource.namespace}
              kind={resource.kind}
              name={resource.name}
            />
          )}
        </div>
      </aside>
    </>
  );
}

// ─── Severity strip (Lumen-distinct) ────────────────────────────────────

function SeverityStrip({ resource, ctx }: { resource: Resource | null; ctx: string }) {
  const isPod = resource?.kind === "pod";
  const { data } = useQuery({
    queryKey: ["k8s", "pod-details", ctx, resource?.namespace, resource?.name],
    queryFn: () => k8s.getPodDetails(ctx, resource!.namespace, resource!.name),
    enabled: isPod && !!resource,
    staleTime: 10_000,
  });
  const color = (() => {
    if (!isPod || !data) return "bg-term-border-soft";
    switch (data.status) {
      case "Running":
        return data.containers.every((c) => c.ready) ? "bg-emerald-500" : "bg-amber-400";
      case "Succeeded":
        return "bg-emerald-500";
      case "Pending":
        return "bg-amber-400";
      case "Failed":
        return "bg-term-red";
      default:
        return "bg-term-border-soft";
    }
  })();
  return <div className={cn("h-[3px] shrink-0", color)} />;
}

// ─── Header with action icons + Lumen keyboard hint chips ───────────────

function Header({
  titleId,
  ctx,
  resource,
  isPod,
  downloading,
  onViewLogs,
  onDownloadLogs,
  onShellExec,
  onEditYaml,
  deleting,
  onDelete,
  onClose,
}: {
  titleId: string;
  ctx: string;
  resource: Resource | null;
  isPod: boolean;
  downloading: boolean;
  onViewLogs: () => void;
  onDownloadLogs: () => void;
  onShellExec: () => void;
  onEditYaml: () => void;
  deleting: boolean;
  onDelete: () => void;
  onClose: () => void;
}) {
  const kind = resource?.kind as WorkloadKind | undefined;
  const canDelete = useQuery({
    queryKey: [
      "k8s",
      "access",
      ctx,
      resource?.namespace,
      resource?.kind,
      resource?.name,
      "delete",
    ],
    queryFn: () =>
      k8s.checkAccess(
        {
          kind: kind!,
          verb: "delete",
          namespace: resource!.namespace || null,
          name: resource!.name,
        },
        ctx,
      ),
    enabled: !!resource && !!kind,
    staleTime: 15_000,
  });
  if (!resource) return null;
  const deleteDisabled =
    deleting || canDelete.isLoading || canDelete.data?.allowed !== true;
  return (
    <div className="min-h-12 px-3 py-2 flex items-center gap-2 border-b border-term-border-soft shrink-0 bg-term-panel">
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] uppercase tracking-wide text-term-subtle">
            {resource.kind}
          </span>
          <span className="text-term-subtle">/</span>
          <span
            id={titleId}
            className="text-[13px] text-term-fg font-medium font-mono truncate"
          >
            {resource.name}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-term-subtle min-w-0">
          <span className="font-mono truncate">{resource.namespace}</span>
          <span>/</span>
          <span className="font-mono truncate">ctx: {ctx}</span>
        </div>
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <PinButton
          ctx={ctx}
          resource={{
            kind: resource.kind,
            namespace: resource.namespace,
            name: resource.name,
          }}
        />
        <ActionIcon
          icon={<ScrollText className="size-3.5" />}
          label="logs"
          hint="L"
          disabled={!isPod}
          onClick={onViewLogs}
        />
        <ActionIcon
          icon={
            downloading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )
          }
          label="download"
          hint="D"
          disabled={!isPod || downloading}
          onClick={onDownloadLogs}
        />
        <ActionIcon
          icon={<TerminalSquare className="size-3.5" />}
          label="shell"
          hint="S"
          disabled={!isPod}
          onClick={onShellExec}
        />
        <ActionIcon
          icon={<Pencil className="size-3.5" />}
          label="yaml"
          hint="Y"
          onClick={onEditYaml}
        />
        <ActionIcon
          icon={
            deleting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )
          }
          label={
            canDelete.data?.allowed === false
              ? "delete denied by RBAC"
              : "delete"
          }
          disabled={deleteDisabled}
          onClick={onDelete}
        />
        <ActionIcon
          icon={<X className="size-4" />}
          label="close"
          hint="Esc"
          onClick={onClose}
        />
      </div>
    </div>
  );
}

function ActionIcon({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint ? `${label} (${hint})` : label}
      className={cn(
        "size-7 inline-flex items-center justify-center rounded",
        "text-term-muted hover:text-term-fg hover:bg-term-panel-2",
        "disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-term-muted",
        "transition-colors",
      )}
    >
      {icon}
    </button>
  );
}

// ─── Tabs ──────────────────────────────────────────────────────────────

function Tabs({
  activeTab,
  onChange,
  showLogsTab,
}: {
  activeTab: DrawerTab;
  onChange: (t: DrawerTab) => void;
  showLogsTab: boolean;
}) {
  const tabs: Array<[DrawerTab, string, boolean]> = [
    ["overview", "overview", true],
    ["logs", "logs", showLogsTab],
    ["events", "events", true],
    ["yaml", "yaml", true],
  ];
  return (
    <div className="flex items-center gap-0 border-b border-term-border-soft bg-term-panel-2 shrink-0 px-2">
      {tabs.map(([id, label, enabled]) => (
        <button
          key={id}
          type="button"
          disabled={!enabled}
          onClick={() => enabled && onChange(id)}
          className={cn(
            "h-9 px-3 text-[12px] border-b-2 transition-colors",
            activeTab === id && enabled
              ? "border-term-green text-term-fg"
              : "border-transparent text-term-muted hover:text-term-fg",
            !enabled && "opacity-30 cursor-not-allowed",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ─── Properties tab ────────────────────────────────────────────────────

function PropertiesTab({
  ctx,
  resource,
  isPod,
}: {
  ctx: string;
  resource: Resource;
  isPod: boolean;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["k8s", "pod-details", ctx, resource.namespace, resource.name],
    queryFn: () => k8s.getPodDetails(ctx, resource.namespace, resource.name),
    enabled: isPod,
    staleTime: 10_000,
  });
  if (!isPod) {
    return <NonPodPropertiesTab ctx={ctx} resource={resource} />;
  }
  if (isLoading) {
    return (
      <div className="p-6 text-[12px] text-term-muted flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin" /> loading pod details…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6 text-[12px] text-term-red flex items-center gap-2">
        <AlertTriangle className="size-3.5" />
        failed to load pod details
      </div>
    );
  }
  return (
    <div className="p-4 space-y-5">
      <PodEvidenceSummary data={data} />
      <RecentEventsSection ctx={ctx} resource={resource} />
      {(data.cpu_usage_milli !== null || data.mem_usage_bytes !== null) && (
        <Section title="metrics">
          <MetricsTiles
            ctx={ctx}
            resource={resource}
            cpuMilli={data.cpu_usage_milli}
            memBytes={data.mem_usage_bytes}
          />
        </Section>
      )}
      <Section title="properties">
        <Dl>
          <DlRow label="created" value={formatRelative(data.created_at_ms)} />
          <DlRow label="status" value={<StatusText status={data.status} />} />
          <DlRow label="qos class" value={data.qos_class} />
          <DlRow label="node" value={data.node_name ?? "—"} />
          <DlRow label="pod ip" value={data.pod_ip ?? "—"} mono />
          {data.pod_ips.length > 1 && (
            <DlRow label="pod ips" value={data.pod_ips.join(", ")} mono />
          )}
          <DlRow label="service account" value={data.service_account ?? "—"} mono />
          <DlRow
            label="controlled by"
            value={
              data.controlled_by
                ? `${data.controlled_by.kind} ${data.controlled_by.name}`
                : "—"
            }
            mono
          />
        </Dl>
      </Section>
      <Section title="conditions">
        <div className="flex flex-wrap gap-1">
          {data.conditions.map((c) => (
            <ConditionPill key={c.type} type={c.type} status={c.status} />
          ))}
          {data.conditions.length === 0 && (
            <span className="text-[11px] text-term-subtle">no conditions reported</span>
          )}
        </div>
      </Section>
      {data.tolerations > 0 && (
        <Section title="tolerations">
          <div className="text-[12px] text-term-muted">
            {data.tolerations} {data.tolerations === 1 ? "toleration" : "tolerations"}
          </div>
        </Section>
      )}
      <Section title="labels">
        <LabelPills entries={data.labels} max={8} />
      </Section>
      {Object.keys(data.annotations).length > 0 && (
        <Section title="annotations">
          <details className="group">
            <summary className="cursor-pointer text-[11px] text-term-muted hover:text-term-fg">
              {Object.keys(data.annotations).length} annotations · click to expand
            </summary>
            <div className="mt-2 space-y-0.5">
              {Object.entries(data.annotations).map(([k, v]) => (
                <div key={k} className="text-[11px] font-mono break-all">
                  <span className="text-term-subtle">{k}</span>
                  <span className="text-term-muted">=</span>
                  <span className="text-term-fg">{v}</span>
                </div>
              ))}
            </div>
          </details>
        </Section>
      )}
      <Section title="containers">
        <div className="space-y-2">
          {data.containers.map((c) => (
            <ContainerCard key={c.name} container={c} />
          ))}
        </div>
      </Section>
    </div>
  );
}

function PodEvidenceSummary({
  data,
}: {
  data: Awaited<ReturnType<typeof k8s.getPodDetails>>;
}) {
  const ready = data.containers.filter((c) => c.ready).length;
  const restarts = data.containers.reduce((sum, c) => sum + c.restart_count, 0);
  const cells = [
    { label: "status", value: <StatusText status={data.status} /> },
    { label: "ready", value: `${ready}/${data.containers.length}` },
    {
      label: "restarts",
      value: restarts,
      tone: restarts > 0 ? "text-amber-400" : "text-term-fg",
    },
    { label: "age", value: formatRelative(data.created_at_ms) },
    { label: "node", value: data.node_name ?? "-" },
  ];
  return (
    <Section title="overview">
      <div className="grid grid-cols-2 gap-2">
        {cells.map((cell) => (
          <div
            key={cell.label}
            className="rounded border border-term-border-soft bg-term-panel-2 px-2.5 py-2 min-w-0"
          >
            <div className="text-[10px] uppercase tracking-wide text-term-subtle">
              {cell.label}
            </div>
            <div
              className={cn(
                "mt-1 text-[12px] font-mono text-term-fg truncate",
                cell.tone,
              )}
              title={String(cell.value)}
            >
              {cell.value}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ─── Inline last-N events (Lumen-distinct) ──────────────────────────────
//
// Lens forces a tab-switch to see events. We surface the most recent 3
// inline at the bottom of Properties so warnings show up before the user
// has to look for them. Full list still lives behind the "events" tab.

function RecentEventsSection({
  ctx,
  resource,
}: {
  ctx: string;
  resource: Resource;
}) {
  const kind = resource.kind as Parameters<typeof k8s.listEventsFor>[1];
  const { data } = useQuery({
    queryKey: [
      "k8s",
      "resource-events",
      ctx,
      resource.namespace,
      kind,
      resource.name,
    ],
    queryFn: () => k8s.listEventsFor(resource.namespace, kind, resource.name, ctx),
    staleTime: 10_000,
    refetchInterval: 5_000,
  });
  if (!data || data.length === 0) return null;
  const top = data.slice(0, 3);
  const more = data.length - top.length;
  return (
    <Section title="recent events">
      <div className="space-y-1.5">
        {top.map((e, i) => (
          <div
            key={i}
            className={cn(
              "rounded border border-term-border-soft bg-term-panel-2 px-2 py-1.5 text-[11px]",
              e.type_ === "Warning" && "border-l-2 border-l-amber-400",
            )}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <span
                className={cn(
                  "inline-flex px-1 rounded text-[10px] border tabular-nums",
                  e.type_ === "Warning"
                    ? "text-amber-400 border-amber-400/40 bg-amber-400/10"
                    : "text-term-muted border-term-border-soft",
                )}
              >
                {e.type_}
              </span>
              <span className="text-term-fg font-mono">{e.reason}</span>
              <span className="ml-auto text-term-subtle font-mono">
                {e.ts ? formatRelative(Date.parse(e.ts)) : "—"}
              </span>
            </div>
            <div className="text-term-muted line-clamp-2" title={e.message}>
              {e.message}
            </div>
          </div>
        ))}
        {more > 0 && (
          <div className="text-[10px] text-term-subtle pt-1">
            + {more} more — see <span className="text-term-muted">events</span> tab
          </div>
        )}
      </div>
    </Section>
  );
}

// ─── Generic properties tab for non-pod kinds ───────────────────────────
//
// Pods get a rich, kind-specific Properties tab via `get_pod_details`.
// Everything else gets a lighter view sourced from `getResource` —
// metadata + labels + owner refs. Kind-specific richness (replicas for
// Deployments, ports for Services, capacity for PVCs, etc.) is a
// follow-up; this is the parity v1.

function NonPodPropertiesTab({
  ctx,
  resource,
}: {
  ctx: string;
  resource: Resource;
}) {
  const kind = resource.kind as Parameters<typeof k8s.getResource>[1];
  const { data, isLoading, error } = useQuery({
    queryKey: [
      "k8s",
      "resource-meta",
      ctx,
      resource.namespace,
      kind,
      resource.name,
    ],
    queryFn: () => k8s.getResource(resource.namespace, kind, resource.name, ctx),
    staleTime: 10_000,
  });
  if (isLoading) {
    return (
      <div className="p-6 text-[12px] text-term-muted flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin" /> loading details…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6 text-[12px] text-term-red flex items-center gap-2">
        <AlertTriangle className="size-3.5" /> failed to load details
      </div>
    );
  }
  const s = data.summary;
  const healthClass =
    s.health === "healthy"
      ? "text-emerald-400"
      : s.health === "degraded"
        ? "text-amber-400"
        : s.health === "failed"
          ? "text-term-red"
          : "text-term-muted";
  return (
    <div className="p-4 space-y-5">
      <Section title="properties">
        <Dl>
          <DlRow label="kind" value={s.kind} />
          <DlRow label="namespace" value={s.namespace || "—"} mono />
          <DlRow
            label="age"
            value={`${formatRelativeFromAge(s.age_seconds)} (${s.age_seconds}s)`}
          />
          <DlRow label="ready" value={s.ready || "—"} mono />
          <DlRow
            label="health"
            value={<span className={healthClass}>{s.health}</span>}
          />
        </Dl>
      </Section>
      {data.owner_refs.length > 0 && (
        <Section title="owners">
          <div className="space-y-0.5">
            {data.owner_refs.map((o) => (
              <div key={`${o.kind}/${o.name}`} className="text-[11px] font-mono">
                <span className="text-term-subtle">{o.kind}</span>{" "}
                <span className="text-term-fg">{o.name}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
      {isRbacKind(s.kind) && (
        <RbacDetailsSection ctx={ctx} resource={resource} kind={s.kind} />
      )}
      {isStorageKind(s.kind) && (
        <StorageDetailsSection ctx={ctx} resource={resource} kind={s.kind} />
      )}
      <Section title="labels">
        <LabelPills entries={s.labels} max={8} />
      </Section>
    </div>
  );
}

function isRbacKind(kind: WorkloadKind): boolean {
  return (
    kind === "role" ||
    kind === "clusterrole" ||
    kind === "rolebinding" ||
    kind === "clusterrolebinding"
  );
}

function isStorageKind(kind: WorkloadKind): boolean {
  return (
    kind === "persistentvolumeclaim" ||
    kind === "persistentvolume" ||
    kind === "storageclass"
  );
}

function RbacDetailsSection({
  ctx,
  resource,
  kind,
}: {
  ctx: string;
  resource: Resource;
  kind: WorkloadKind;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["k8s", "rbac-details", ctx, resource.namespace, kind, resource.name],
    queryFn: () =>
      k8s.getRbacDetails(resource.namespace, kind, resource.name, ctx || undefined),
    staleTime: 10_000,
  });

  if (isLoading) {
    return (
      <Section title="rbac">
        <div className="text-[12px] text-term-muted flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" /> loading RBAC details…
        </div>
      </Section>
    );
  }
  if (error || !data) {
    return (
      <Section title="rbac">
        <div className="text-[12px] text-term-red flex items-center gap-2">
          <AlertTriangle className="size-3.5" /> failed to load RBAC details
        </div>
      </Section>
    );
  }

  return (
    <>
      {(data.role_ref || data.subjects.length > 0) && (
        <Section title="binding">
          <Dl>
            {data.role_ref && <DlRow label="role ref" value={data.role_ref} mono />}
            {data.subjects.length > 0 && (
              <DlRow
                label="subjects"
                value={
                  <div className="space-y-1">
                    {data.subjects.map((subject) => (
                      <div
                        key={`${subject.kind}/${subject.namespace ?? ""}/${subject.name}`}
                        className="font-mono text-[11px] text-term-fg"
                      >
                        <span className="text-term-subtle">{subject.kind}</span>{" "}
                        {subject.namespace ? `${subject.namespace}/` : ""}
                        {subject.name}
                      </div>
                    ))}
                  </div>
                }
              />
            )}
          </Dl>
        </Section>
      )}
      <Section title="rules">
        {data.rules.length === 0 ? (
          <div className="text-[11px] text-term-subtle">
            no readable policy rules found
          </div>
        ) : (
          <div className="space-y-2">
            {data.rules.map((rule, index) => (
              <div
                key={index}
                className="rounded border border-term-border-soft bg-term-panel-2 px-2.5 py-2"
              >
                <div className="flex flex-wrap gap-1">
                  {rule.verbs.map((verb) => (
                    <span
                      key={verb}
                      className={cn(
                        "px-1.5 py-0.5 rounded border text-[10px] font-mono",
                        verb === "*" || verb === "delete" || verb === "deletecollection"
                          ? "border-term-red/40 bg-term-red/10 text-term-red"
                          : verb === "create" || verb === "patch" || verb === "update"
                            ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                            : "border-term-border-soft bg-term-panel text-term-muted",
                      )}
                    >
                      {verb}
                    </span>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
                  <span className="text-term-subtle">api groups</span>
                  <span className="font-mono text-term-muted break-all">
                    {rule.api_groups.join(", ")}
                  </span>
                  <span className="text-term-subtle">resources</span>
                  <span className="font-mono text-term-fg break-all">
                    {rule.resources.join(", ")}
                  </span>
                  {rule.resource_names.length > 0 && (
                    <>
                      <span className="text-term-subtle">names</span>
                      <span className="font-mono text-term-muted break-all">
                        {rule.resource_names.join(", ")}
                      </span>
                    </>
                  )}
                  {rule.non_resource_urls.length > 0 && (
                    <>
                      <span className="text-term-subtle">urls</span>
                      <span className="font-mono text-term-muted break-all">
                        {rule.non_resource_urls.join(", ")}
                      </span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

function StorageDetailsSection({
  ctx,
  resource,
  kind,
}: {
  ctx: string;
  resource: Resource;
  kind: WorkloadKind;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["k8s", "storage-details", ctx, resource.namespace, kind, resource.name],
    queryFn: () =>
      k8s.getStorageDetails(
        resource.namespace,
        kind,
        resource.name,
        ctx || undefined,
      ),
    staleTime: 10_000,
  });

  if (isLoading) {
    return (
      <Section title="storage">
        <div className="text-[12px] text-term-muted flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" /> loading storage details…
        </div>
      </Section>
    );
  }
  if (error || !data) {
    return (
      <Section title="storage">
        <div className="text-[12px] text-term-red flex items-center gap-2">
          <AlertTriangle className="size-3.5" /> failed to load storage details
        </div>
      </Section>
    );
  }

  const params = Object.entries(data.parameters);
  return (
    <Section title="storage">
      <Dl>
        <DlRow label="phase" value={data.phase ?? "—"} />
        <DlRow label="capacity" value={data.capacity ?? "—"} mono />
        <DlRow
          label="access modes"
          value={data.access_modes.length ? data.access_modes.join(", ") : "—"}
          mono
        />
        <DlRow label="storage class" value={data.storage_class ?? "—"} mono />
        {data.volume_name && <DlRow label="volume" value={data.volume_name} mono />}
        {data.claim_ref && <DlRow label="claim" value={data.claim_ref} mono />}
        {data.provisioner && (
          <DlRow label="provisioner" value={data.provisioner} mono />
        )}
        {data.reclaim_policy && (
          <DlRow label="reclaim" value={data.reclaim_policy} mono />
        )}
        {data.binding_mode && <DlRow label="binding" value={data.binding_mode} mono />}
        {data.allow_expansion !== null && (
          <DlRow
            label="expansion"
            value={data.allow_expansion ? "allowed" : "not allowed"}
          />
        )}
        {params.length > 0 && (
          <DlRow
            label="parameters"
            value={
              <div className="space-y-1">
                {params.map(([key, value]) => (
                  <div key={key} className="font-mono text-[11px] break-all">
                    <span className="text-term-subtle">{key}</span>
                    <span className="text-term-muted">=</span>
                    <span className="text-term-fg">{value}</span>
                  </div>
                ))}
              </div>
            }
          />
        )}
      </Dl>
    </Section>
  );
}

function formatRelativeFromAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-term-subtle">{title}</span>
        <span className="flex-1 border-t border-dashed border-term-border-soft" />
      </div>
      {children}
    </section>
  );
}

// ─── Metrics tiles with sparkline (Lumen-distinct) ──────────────────────
//
// No backend metrics-history command — instead we keep an in-memory ring
// buffer per pod, populated as the existing 5s react-query refetch ticks
// new cpu/mem samples. A 60-point buffer covers ~5 minutes of trend data.
// Resets when the drawer closes; persists for the duration of a session
// while the drawer's PropertiesTab stays mounted. Compact and dependency-
// free — no chart library bloat.

const HISTORY_CAP = 60;

function MetricsTiles({
  ctx,
  resource,
  cpuMilli,
  memBytes,
}: {
  ctx: string;
  resource: Resource;
  cpuMilli: number | null;
  memBytes: number | null;
}) {
  const key = `${ctx}|${resource.namespace}|${resource.name}`;
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);
  // Reset buffers when the drawer points at a different resource.
  useEffect(() => {
    setCpuHist([]);
    setMemHist([]);
  }, [key]);
  // Append a sample whenever new data arrives. Tick-deduped: same value
  // back-to-back gets folded so flat lines stay flat instead of stacking.
  useEffect(() => {
    if (cpuMilli !== null) {
      setCpuHist((prev) => {
        const next = prev.length && prev[prev.length - 1] === cpuMilli ? prev : [...prev, cpuMilli];
        return next.length > HISTORY_CAP ? next.slice(-HISTORY_CAP) : next;
      });
    }
    if (memBytes !== null) {
      setMemHist((prev) => {
        const next = prev.length && prev[prev.length - 1] === memBytes ? prev : [...prev, memBytes];
        return next.length > HISTORY_CAP ? next.slice(-HISTORY_CAP) : next;
      });
    }
  }, [cpuMilli, memBytes]);

  return (
    <div className="grid grid-cols-2 gap-2">
      <SparklineTile
        label="cpu"
        value={cpuMilli !== null ? `${(cpuMilli / 1000).toFixed(3)}` : "—"}
        suffix="cores"
        history={cpuHist}
        stroke="text-emerald-400"
      />
      <SparklineTile
        label="memory"
        value={memBytes !== null ? formatBytes(memBytes) : "—"}
        history={memHist}
        stroke="text-amber-400"
      />
    </div>
  );
}

function SparklineTile({
  label,
  value,
  suffix,
  history,
  stroke,
}: {
  label: string;
  value: string;
  suffix?: string;
  history: number[];
  stroke: string;
}) {
  return (
    <div className="rounded border border-term-border-soft bg-term-panel-2 p-3">
      <div className="text-[10px] uppercase tracking-wide text-term-subtle">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[20px] font-mono tabular-nums text-term-fg">{value}</span>
        {suffix && <span className="text-[10px] text-term-muted">{suffix}</span>}
      </div>
      <Sparkline values={history} className={cn("mt-1.5 h-6", stroke)} />
    </div>
  );
}

function Sparkline({
  values,
  className,
}: {
  values: number[];
  className?: string;
}) {
  if (values.length < 2) {
    return (
      <div className={cn("text-[10px] text-term-subtle", className)}>
        gathering data…
      </div>
    );
  }
  const W = 100;
  const H = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = W / Math.max(values.length - 1, 1);
  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = H - ((v - min) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("w-full", className)}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Last-sample anchor dot — Lumen-distinct, makes "now" obvious. */}
      <circle
        cx={(values.length - 1) * step}
        cy={H - ((values[values.length - 1] - min) / range) * H}
        r="1.4"
        fill="currentColor"
      />
    </svg>
  );
}

function Dl({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 gap-x-3">{children}</dl>;
}

function DlRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-[11px] text-term-subtle">{label}</dt>
      <dd
        className={cn(
          "text-[12px] text-term-fg break-all",
          mono && "font-mono tabular-nums",
        )}
      >
        {value}
      </dd>
    </>
  );
}

function StatusText({ status }: { status: string }) {
  const cls =
    status === "Running" || status === "Succeeded"
      ? "text-emerald-400"
      : status === "Pending"
        ? "text-amber-400"
        : status === "Failed"
          ? "text-term-red"
          : "text-term-muted";
  return <span className={cls}>{status}</span>;
}

function ConditionPill({ type, status }: { type: string; status: string }) {
  const cls =
    status === "True"
      ? "border-emerald-400/40 text-emerald-400 bg-emerald-400/10"
      : status === "False"
        ? "border-term-red/40 text-term-red bg-term-red/10"
        : "border-term-border-soft text-term-muted bg-term-panel-2";
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border",
        cls,
      )}
    >
      {type}
    </span>
  );
}

function LabelPills({
  entries,
  max,
}: {
  entries: Record<string, string>;
  max: number;
}) {
  const list = Object.entries(entries);
  const visible = list.slice(0, max);
  const hidden = list.length - visible.length;
  if (list.length === 0) {
    return <span className="text-[11px] text-term-subtle">no labels</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map(([k, v]) => (
        <span
          key={k}
          className="inline-flex items-center px-1.5 py-0.5 rounded bg-term-panel-2 border border-term-border-soft text-[10px] text-term-muted font-mono"
        >
          <span className="text-term-subtle">{k}</span>
          <span className="text-term-subtle">=</span>
          <span className="text-term-fg">{v}</span>
        </span>
      ))}
      {hidden > 0 && (
        <span className="px-1.5 py-0.5 text-[10px] text-term-subtle">+{hidden} more</span>
      )}
    </div>
  );
}

// ─── Container chiclets (Lumen-distinct) ───────────────────────────────

function ContainerCard({ container: c }: { container: ContainerInfo }) {
  const stateColor = c.state.startsWith("Running")
    ? "bg-emerald-500"
    : c.state.startsWith("Waiting")
      ? "bg-amber-400"
      : c.state.startsWith("Terminated")
        ? "bg-term-red"
        : "bg-term-border-soft";
  return (
    <div className="rounded border border-term-border-soft bg-term-panel-2 p-2.5">
      <div className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full shrink-0", stateColor)} />
        <span className="text-[12px] text-term-fg font-medium font-mono truncate flex-1">
          {c.name}
        </span>
        {c.restart_count > 0 && (
          <span className="px-1 rounded bg-amber-400/15 text-amber-400 text-[10px] border border-amber-400/30 tabular-nums">
            ↻ {c.restart_count}
          </span>
        )}
        <span className="text-[10px] text-term-subtle">{c.state}</span>
      </div>
      <div className="mt-1 text-[11px] text-term-muted font-mono truncate">{c.image}</div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-term-subtle">
        <div className="flex justify-between">
          <span>cpu req</span>
          <span className="text-term-muted font-mono tabular-nums">
            {c.cpu_request_milli !== null ? `${c.cpu_request_milli}m` : "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span>cpu lim</span>
          <span className="text-term-muted font-mono tabular-nums">
            {c.cpu_limit_milli !== null ? `${c.cpu_limit_milli}m` : "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span>mem req</span>
          <span className="text-term-muted font-mono tabular-nums">
            {c.mem_request_bytes !== null ? formatBytes(c.mem_request_bytes) : "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span>mem lim</span>
          <span className="text-term-muted font-mono tabular-nums">
            {c.mem_limit_bytes !== null ? formatBytes(c.mem_limit_bytes) : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── YAML tab ──────────────────────────────────────────────────────────

function YamlTab({ ctx, resource }: { ctx: string; resource: Resource }) {
  const kind = resource.kind as Parameters<typeof k8s.getResource>[1];
  const { data, isLoading, error } = useQuery({
    queryKey: ["k8s", "resource-yaml", ctx, resource.namespace, kind, resource.name],
    queryFn: () => k8s.getResource(resource.namespace, kind, resource.name, ctx),
    staleTime: 30_000,
  });
  if (isLoading) {
    return (
      <div className="p-4 text-[12px] text-term-muted flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin" /> loading yaml…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-4 text-[12px] text-term-red flex items-center gap-2">
        <AlertTriangle className="size-3.5" />
        failed to load yaml
      </div>
    );
  }
  return (
    <pre className="p-4 m-0 text-[11px] font-mono whitespace-pre-wrap break-all bg-term-panel-2 text-term-fg">
      {data.yaml}
    </pre>
  );
}

// ─── Events tab ────────────────────────────────────────────────────────

function EventsTab({ ctx, resource }: { ctx: string; resource: Resource }) {
  const kind = resource.kind as Parameters<typeof k8s.listEventsFor>[1];
  const { data, isLoading, error } = useQuery({
    queryKey: [
      "k8s",
      "resource-events",
      ctx,
      resource.namespace,
      kind,
      resource.name,
    ],
    queryFn: () => k8s.listEventsFor(resource.namespace, kind, resource.name, ctx),
    staleTime: 10_000,
    refetchInterval: 5_000,
  });
  if (isLoading) {
    return (
      <div className="p-4 text-[12px] text-term-muted flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin" /> loading events…
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4 text-[12px] text-term-red">failed to load events</div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <div className="p-4 text-[12px] text-term-muted">no events for this resource.</div>
    );
  }
  return (
    <div className="p-2">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-term-subtle text-left uppercase tracking-wide">
            <th className="px-2 py-1.5 font-normal">time</th>
            <th className="px-2 py-1.5 font-normal">type</th>
            <th className="px-2 py-1.5 font-normal">reason</th>
            <th className="px-2 py-1.5 font-normal">message</th>
          </tr>
        </thead>
        <tbody>
          {data.map((e, i) => (
            <tr
              key={i}
              className={cn(
                "border-t border-term-border-soft align-top",
                e.type_ === "Warning" && "bg-amber-400/5",
              )}
            >
              <td className="px-2 py-1.5 text-term-muted whitespace-nowrap font-mono">
                {e.ts ? formatRelative(Date.parse(e.ts)) : "—"}
              </td>
              <td className="px-2 py-1.5">
                <span
                  className={cn(
                    "inline-flex px-1 rounded text-[10px] border",
                    e.type_ === "Warning"
                      ? "text-amber-400 border-amber-400/40 bg-amber-400/10"
                      : "text-term-muted border-term-border-soft",
                  )}
                >
                  {e.type_}
                </span>
              </td>
              <td className="px-2 py-1.5 text-term-fg whitespace-nowrap">{e.reason}</td>
              <td className="px-2 py-1.5 text-term-muted">{e.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

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

function formatRelative(ms: number): string {
  if (!ms) return "—";
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
