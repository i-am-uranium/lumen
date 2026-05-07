import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, Channel } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Eye,
  FlaskConical,
  Loader2,
  Minus,
  Pencil,
  Plus,
  RotateCw,
  ScrollText,
  Sparkles,
  TerminalSquare,
  Container,
  GitCompareArrows,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { PinButton } from "@/components/PinButton";
import { LogsViewer } from "./logs/LogsViewer";
import { useShellDock } from "@/hooks/useShellDock";
import { useUiSettings } from "@/state/uiSettings";
import { aiResourceUrl } from "@/lib/aiNavigation";
import { k8s, type ContainerInfo, type WorkloadKind } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { useShortcut } from "@/lib/shortcuts";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import {
  DrawerBackdrop,
  DrawerHeader,
  DrawerPanel,
  DrawerResizeHandle,
  DrawerTabButton,
  DrawerTabs,
} from "@/components/lumen/drawer";

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
type PendingResourceAction =
  | { kind: "restart" }
  | { kind: "scale"; replicas: number }
  | { kind: "trigger" }
  | { kind: "setImage"; container: string; image: string };

function isRestartableKind(kind: string | undefined): boolean {
  return kind === "deployment" || kind === "statefulset" || kind === "daemonset";
}

function isScalableKind(kind: string | undefined): boolean {
  return kind === "deployment" || kind === "statefulset";
}

function isTriggerableKind(kind: string | undefined): boolean {
  return kind === "cronjob";
}

function desiredReplicasFromReady(ready: string | undefined): number | null {
  if (!ready) return null;
  const match = ready.match(/^\d+\/(\d+)$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

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
  const canViewLogs = isPod || ["deployment", "statefulset", "daemonset", "replicaset", "job"].includes(resource?.kind ?? "");
  const [activeTab, setActiveTab] = useState<DrawerTab>("overview");
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingResourceAction | null>(null);
  // Image hot-swap dialog — separate from `pendingAction` because it needs
  // its own form inputs (container + image) that the user fills before
  // confirming. Once submitted it folds into pendingAction for the
  // existing handleResourceAction → toast → invalidate flow.
  const [setImageOpen, setSetImageOpen] = useState(false);
  // Cross-cluster diff dialog — read-only view, no action lifecycle so
  // it doesn't go through pendingAction.
  const [compareOpen, setCompareOpen] = useState(false);
  const { openSession } = useShellDock();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const resourceKind = resource?.kind as WorkloadKind | undefined;
  const readOnly = useUiSettings((s) => s.readOnly);
  // Capability flags fold the global read-only switch in. Header uses these
  // for both disabled state and tooltips, so a single `false` propagates
  // cleanly without touching downstream code paths.
  const restartable = !readOnly && isRestartableKind(resource?.kind);
  const scalable = !readOnly && isScalableKind(resource?.kind);
  const triggerable = !readOnly && isTriggerableKind(resource?.kind);
  // Image hot-swap reuses the restartable-kind set: only Deployment /
  // StatefulSet / DaemonSet have a pod template to patch. The dialog does
  // not list containers — for v1 the user types the container name
  // directly; future iteration can fetch the spec and prefill.
  const imageSettable = !readOnly && isRestartableKind(resource?.kind);

  // Pre-load pod-details so the Shell action can pick a default container
  // synchronously. SeverityStrip already runs the same query, so this is a
  // cache hit in practice.
  const podDetails = useQuery({
    queryKey: ["k8s", "pod-details", ctx, resource?.namespace, resource?.name],
    queryFn: () => k8s.getPodDetails(ctx, resource!.namespace, resource!.name),
    enabled: isPod && !!resource,
    staleTime: 10_000,
  });

  const actionResource = useQuery({
    queryKey: [
      "k8s",
      "resource-action-meta",
      ctx,
      resource?.namespace,
      resource?.kind,
      resource?.name,
    ],
    queryFn: () =>
      k8s.getResource(
        resource!.namespace,
        resourceKind!,
        resource!.name,
        ctx || undefined,
      ),
    enabled: !!resource && !!resourceKind && (restartable || scalable),
    staleTime: 2_000,
    refetchInterval: 3_000,
  });
  const desiredReplicas = desiredReplicasFromReady(actionResource.data?.summary.ready);

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

  function askLumen() {
    if (!resource) return;
    navigate(aiResourceUrl(ctx, resource));
  }

  // Reset when drawer opens for a new resource.
  useEffect(() => {
    if (resource) {
      setActiveTab("overview");
      setDeleteConfirmOpen(false);
      setPendingAction(null);
    }
  }, [resource?.kind, resource?.namespace, resource?.name]);

  // Hotkeys (only when drawer is open). Registered through the shortcut
  // registry so users can rebind them from Settings — see shortcuts.ts
  // for the per-action ids. `enabled: open` keeps the listeners off when
  // no resource is focused.
  useShortcut("drawerClose", () => onClose(), { enabled: open });
  useShortcut(
    "drawerLogs",
    () => {
      if (canViewLogs) handleViewLogs();
    },
    { enabled: open },
  );
  useShortcut(
    "drawerShell",
    () => {
      if (isPod) openShell();
    },
    { enabled: open },
  );
  useShortcut(
    "drawerDownload",
    () => {
      if (isPod) handleDownloadLogs();
    },
    { enabled: open },
  );
  useShortcut("drawerYaml", () => setActiveTab("yaml"), { enabled: open });

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
      setDeleteConfirmOpen(false);
      onClose();
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setDeleting(false);
    }
  }

  async function handleResourceAction() {
    if (!resource || !resourceKind || !pendingAction || actionBusy) return;
    setActionBusy(true);
    try {
      if (pendingAction.kind === "restart") {
        await k8s.restartWorkload(
          resource.namespace,
          resourceKind,
          resource.name,
          ctx || undefined,
        );
        toast.success(`restart triggered for ${resource.kind}/${resource.name}`);
      } else if (pendingAction.kind === "trigger") {
        const jobName = await k8s.triggerCronjob(
          resource.namespace,
          resource.name,
          ctx || undefined,
        );
        toast.success(`triggered cronjob/${resource.name} → job/${jobName}`);
      } else if (pendingAction.kind === "setImage") {
        await k8s.setWorkloadImage(
          resource.namespace,
          resourceKind,
          resource.name,
          pendingAction.container,
          pendingAction.image,
          ctx || undefined,
        );
        toast.success(
          `set ${pendingAction.container}=${pendingAction.image} on ${resource.kind}/${resource.name}`,
        );
      } else {
        await k8s.scaleWorkload(
          resource.namespace,
          resourceKind,
          resource.name,
          pendingAction.replicas,
          ctx || undefined,
        );
        toast.success(`scaled ${resource.kind}/${resource.name} to ${pendingAction.replicas}`);
      }
      setPendingAction(null);
      await qc.invalidateQueries({ queryKey: ["k8s", "workloads"] });
      await qc.invalidateQueries({ queryKey: ["k8s", "resource-meta"] });
      await qc.invalidateQueries({ queryKey: ["k8s", "resource-action-meta"] });
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setActionBusy(false);
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
      <DrawerBackdrop onClick={onClose} />
      {/* Side-docked panel */}
      <DrawerPanel
        width={width}
        role="dialog"
        aria-labelledby={titleId}
      >
        {/* Resize handle — invisible 4px strip on the left edge that grows
            into a 1px term-green line on hover/drag. Lumen-distinct: keeps
            the chrome minimal until interacted with. */}
        <DrawerResizeHandle onPointerDown={startResize} />
        <SeverityStrip resource={resource} ctx={ctx} />
        <Header
          titleId={titleId}
          ctx={ctx}
          resource={resource}
          isPod={isPod}
          canViewLogs={canViewLogs}
          downloading={downloading}
          onViewLogs={handleViewLogs}
          onDownloadLogs={handleDownloadLogs}
          onShellExec={openShell}
          onAskLumen={askLumen}
          onEditYaml={() => setActiveTab("yaml")}
          restartable={restartable}
          scalable={scalable}
          triggerable={triggerable}
          currentReplicas={desiredReplicas}
          actionBusy={actionBusy}
          actionMetaLoading={actionResource.isLoading}
          onRestart={() => setPendingAction({ kind: "restart" })}
          onScaleDown={() =>
            desiredReplicas !== null &&
            setPendingAction({ kind: "scale", replicas: Math.max(0, desiredReplicas - 1) })
          }
          onScaleUp={() =>
            desiredReplicas !== null &&
            setPendingAction({ kind: "scale", replicas: desiredReplicas + 1 })
          }
          onTrigger={() => setPendingAction({ kind: "trigger" })}
          imageSettable={imageSettable}
          onSetImage={() => setSetImageOpen(true)}
          onCompare={() => setCompareOpen(true)}
          deleting={deleting}
          onDelete={() => setDeleteConfirmOpen(true)}
          readOnly={readOnly}
          onClose={onClose}
        />
        <Tabs activeTab={activeTab} onChange={setActiveTab} showLogsTab={canViewLogs} />
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
      </DrawerPanel>
      {resource && (
        <ConfirmActionDialog
          open={deleteConfirmOpen}
          title={`delete ${resource.kind}`}
          description={`This will delete ${resource.kind}/${resource.name} from ${resource.namespace || "cluster scope"} in ${ctx}. The action is sent to Kubernetes immediately after confirmation.`}
          target={`${resource.namespace || "cluster"}/${resource.name}`}
          confirmLabel="delete"
          intent="danger"
          busy={deleting}
          onCancel={() => setDeleteConfirmOpen(false)}
          onConfirm={handleDelete}
        />
      )}
      {resource && pendingAction && (
        <ConfirmActionDialog
          open
          title={
            pendingAction.kind === "restart"
              ? `restart ${resource.kind}`
              : pendingAction.kind === "trigger"
                ? `trigger ${resource.kind}`
                : pendingAction.kind === "setImage"
                  ? `set image on ${resource.kind}`
                  : `scale ${resource.kind}`
          }
          description={
            pendingAction.kind === "restart"
              ? `This will trigger a rolling restart for ${resource.kind}/${resource.name}. Kubernetes will replace pods according to the controller strategy.`
              : pendingAction.kind === "trigger"
                ? `This will create a one-off Job from ${resource.kind}/${resource.name}'s spec. The Job will be owned by the CronJob, so the cluster's history limits and cleanup still apply.`
                : pendingAction.kind === "setImage"
                  ? `This will patch container ${pendingAction.container} on ${resource.kind}/${resource.name} to use image ${pendingAction.image}. Kubernetes will roll the workload through its normal update strategy.`
                  : `This will set replicas for ${resource.kind}/${resource.name} to ${pendingAction.replicas}.`
          }
          target={`${resource.namespace || "cluster"}/${resource.name}`}
          confirmLabel={
            pendingAction.kind === "restart"
              ? "restart"
              : pendingAction.kind === "trigger"
                ? "trigger"
                : pendingAction.kind === "setImage"
                  ? "set image"
                  : "scale"
          }
          intent="warning"
          busy={actionBusy}
          onCancel={() => setPendingAction(null)}
          onConfirm={handleResourceAction}
        />
      )}
      {resource && setImageOpen && (
        <Suspense fallback={null}>
          <SetImageDialog
            resource={resource}
            busy={actionBusy}
            onCancel={() => setSetImageOpen(false)}
            onSubmit={(container, image) => {
              setSetImageOpen(false);
              setPendingAction({ kind: "setImage", container, image });
            }}
          />
        </Suspense>
      )}
      {resource && compareOpen && (
        <Suspense fallback={null}>
          <CompareAcrossClustersDialog
            resource={resource}
            sourceCtx={ctx}
            onClose={() => setCompareOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}

// ─── Lazy-loaded dialogs (chunked out of the workloads route) ─────────────
//
// SetImageDialog and CompareAcrossClustersDialog are conditionally
// rendered behind state flags (setImageOpen / compareOpen). Lazy-loading
// them keeps the workloads chunk lean — users who only browse YAML/logs
// never pay the parse cost for these dialogs. VulnScanSection is lazy
// for the same reason (only relevant for pod properties with containers).
//
// See scripts/check-bundle-budget.mjs — workloads cap was bumped to
// 110 KiB; this split is the path back below 100 KiB.

const SetImageDialog = lazy(() =>
  import("@/components/drawer/SetImageDialog").then((m) => ({
    default: m.SetImageDialog,
  })),
);
const CompareAcrossClustersDialog = lazy(() =>
  import("@/components/drawer/CompareAcrossClustersDialog").then((m) => ({
    default: m.CompareAcrossClustersDialog,
  })),
);
const VulnScanSection = lazy(() =>
  import("@/components/drawer/VulnScanSection").then((m) => ({
    default: m.VulnScanSection,
  })),
);

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
    if (!isPod || !data) return "bg-border-subtle";
    switch (data.status) {
      case "Running":
        return data.containers.every((c) => c.ready) ? "bg-success" : "bg-warning";
      case "Succeeded":
        return "bg-success";
      case "Pending":
        return "bg-warning";
      case "Failed":
        return "bg-danger";
      default:
        return "bg-border-subtle";
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
  canViewLogs,
  downloading,
  onViewLogs,
  onDownloadLogs,
  onShellExec,
  onAskLumen,
  onEditYaml,
  restartable,
  scalable,
  triggerable,
  currentReplicas,
  actionBusy,
  actionMetaLoading,
  onRestart,
  onScaleDown,
  onScaleUp,
  onTrigger,
  imageSettable,
  onSetImage,
  onCompare,
  deleting,
  onDelete,
  readOnly,
  onClose,
}: {
  titleId: string;
  ctx: string;
  resource: Resource | null;
  isPod: boolean;
  canViewLogs: boolean;
  downloading: boolean;
  onViewLogs: () => void;
  onDownloadLogs: () => void;
  onShellExec: () => void;
  onAskLumen: () => void;
  onEditYaml: () => void;
  restartable: boolean;
  scalable: boolean;
  triggerable: boolean;
  currentReplicas: number | null;
  actionBusy: boolean;
  actionMetaLoading: boolean;
  onRestart: () => void;
  onScaleDown: () => void;
  onScaleUp: () => void;
  onTrigger: () => void;
  imageSettable: boolean;
  onSetImage: () => void;
  /** Open the cross-cluster diff dialog. Always available regardless of read-only. */
  onCompare: () => void;
  deleting: boolean;
  onDelete: () => void;
  /** Global read-only switch — disables every destructive action with a tooltip. */
  readOnly: boolean;
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
    deleting || readOnly || canDelete.isLoading || canDelete.data?.allowed !== true;
  const deleteTitle = readOnly
    ? "delete (disabled — read-only mode)"
    : deleteDisabled
      ? "delete"
      : "delete";
  return (
    <DrawerHeader>
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] uppercase tracking-wide text-text-muted">
            {resource.kind}
          </span>
          <span className="text-text-muted">/</span>
          <span
            id={titleId}
            className="text-[13px] text-text-primary font-medium font-mono truncate"
          >
            {resource.name}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted min-w-0">
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
          icon={<Sparkles className="size-3.5" />}
          label="ask Lumen"
          onClick={onAskLumen}
        />
        <ActionIcon
          icon={<ScrollText className="size-3.5" />}
          label="logs"
          hint="L"
          disabled={!canViewLogs}
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
          icon={
            actionBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCw className="size-3.5" />
            )
          }
          label="restart"
          disabled={!restartable || actionBusy}
          onClick={onRestart}
        />
        <ActionIcon
          icon={<Minus className="size-3.5" />}
          label={
            currentReplicas === null
              ? "scale down"
              : `scale down from ${currentReplicas}`
          }
          disabled={
            !scalable ||
            actionBusy ||
            actionMetaLoading ||
            currentReplicas === null ||
            currentReplicas <= 0
          }
          onClick={onScaleDown}
        />
        <ActionIcon
          icon={<Plus className="size-3.5" />}
          label={
            currentReplicas === null
              ? "scale up"
              : `scale up from ${currentReplicas}`
          }
          disabled={
            !scalable || actionBusy || actionMetaLoading || currentReplicas === null
          }
          onClick={onScaleUp}
        />
        {triggerable && (
          <ActionIcon
            icon={
              actionBusy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Zap className="size-3.5" />
              )
            }
            label="trigger now"
            disabled={actionBusy}
            onClick={onTrigger}
          />
        )}
        {imageSettable && (
          <ActionIcon
            icon={<Container className="size-3.5" />}
            label={
              readOnly
                ? "set image (read-only mode)"
                : "set image (rolling update)"
            }
            disabled={actionBusy || readOnly}
            onClick={onSetImage}
          />
        )}
        <ActionIcon
          icon={<GitCompareArrows className="size-3.5" />}
          label="compare across clusters"
          onClick={onCompare}
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
            readOnly
              ? "delete (read-only mode)"
              : canDelete.data?.allowed === false
                ? "delete denied by RBAC"
                : deleteTitle
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
    </DrawerHeader>
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
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint ? `${label} (${hint})` : label}
      variant="ghost"
      size="icon"
      className="size-7 rounded text-text-secondary hover:text-text-primary"
      aria-label={hint ? `${label} (${hint})` : label}
    >
      {icon}
    </Button>
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
    <DrawerTabs>
      {tabs.map(([id, label, enabled]) => (
        <DrawerTabButton
          key={id}
          disabled={!enabled}
          onClick={() => enabled && onChange(id)}
          active={activeTab === id && enabled}
        >
          {label}
        </DrawerTabButton>
      ))}
    </DrawerTabs>
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
    // Poll every 15s so MetricsTiles' sparkline buffer accumulates real
    // time-series. Without this the query is fetch-on-mount only and the
    // sparkline is effectively a single-point chart. metrics-server's
    // own scrape interval is ~60s by default; 15s frontend polls fold
    // into the same value most of the time but pick up changes promptly
    // once metrics-server publishes a new sample.
    refetchInterval: 15_000,
  });
  if (!isPod) {
    return <NonPodPropertiesTab ctx={ctx} resource={resource} />;
  }
  if (isLoading) {
    return (
      <div className="p-6 text-[12px] text-text-secondary flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin" /> loading pod details...
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6 text-[12px] text-danger flex items-center gap-2">
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
            <span className="text-[11px] text-text-muted">no conditions reported</span>
          )}
        </div>
      </Section>
      {data.tolerations > 0 && (
        <Section title="tolerations">
          <div className="text-[12px] text-text-secondary">
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
            <summary className="cursor-pointer text-[11px] text-text-secondary hover:text-text-primary">
              {Object.keys(data.annotations).length} annotations · click to expand
            </summary>
            <div className="mt-2 space-y-0.5">
              {Object.entries(data.annotations).map(([k, v]) => (
                <div key={k} className="text-[11px] font-mono break-all">
                  <span className="text-text-muted">{k}</span>
                  <span className="text-text-secondary">=</span>
                  <span className="text-text-primary">{v}</span>
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
      <Suspense fallback={null}>
        <VulnScanSection containers={data.containers} />
      </Suspense>
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
      tone: restarts > 0 ? "text-warning" : "text-text-primary",
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
            className="rounded-control border border-border-default bg-elevated px-2.5 py-2 min-w-0"
          >
            <div className="text-[10px] uppercase tracking-wide text-text-muted">
              {cell.label}
            </div>
            <div
              className={cn(
                "mt-1 text-[12px] font-mono text-text-primary truncate",
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
              "rounded-control border border-border-default bg-elevated px-2 py-1.5 text-[11px]",
              e.type_ === "Warning" && "border-l-2 border-l-warning",
            )}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <span
                className={cn(
                  "inline-flex px-1 rounded text-[10px] border tabular-nums",
                  e.type_ === "Warning"
                    ? "text-warning border-warning/40 bg-[var(--status-warning-soft)]"
                    : "text-text-secondary border-border-default",
                )}
              >
                {e.type_}
              </span>
              <span className="text-text-primary font-mono">{e.reason}</span>
              <span className="ml-auto text-text-muted font-mono">
                {e.ts ? formatRelative(Date.parse(e.ts)) : "—"}
              </span>
            </div>
            <div className="text-text-secondary line-clamp-2" title={e.message}>
              {e.message}
            </div>
          </div>
        ))}
        {more > 0 && (
          <div className="text-[10px] text-text-muted pt-1">
            + {more} more — see <span className="text-text-secondary">events</span> tab
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
    staleTime: 2_000,
    refetchInterval: 3_000,
  });
  if (isLoading) {
    return (
      <div className="p-6 text-[12px] text-text-secondary flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin" /> loading details...
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6 text-[12px] text-danger flex items-center gap-2">
        <AlertTriangle className="size-3.5" /> failed to load details
      </div>
    );
  }
  const s = data.summary;
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
            value={<StatusBadge status={s.health} />}
          />
        </Dl>
      </Section>
      {data.owner_refs.length > 0 && (
        <Section title="owners">
          <div className="space-y-0.5">
            {data.owner_refs.map((o) => (
              <div key={`${o.kind}/${o.name}`} className="text-[11px] font-mono">
                <span className="text-text-muted">{o.kind}</span>{" "}
                <span className="text-text-primary">{o.name}</span>
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
      {hasResourceInsights(s.kind) && (
        <ResourceInsightsSection ctx={ctx} resource={resource} kind={s.kind} />
      )}
      {s.kind === "cronjob" && (
        <CronjobManualRunsSection ctx={ctx} resource={resource} />
      )}
      <Section title="labels">
        <LabelPills entries={s.labels} max={8} />
      </Section>
    </div>
  );
}

// ─── CronJob manual-runs section (C3) ───────────────────────────────────

function CronjobManualRunsSection({
  ctx,
  resource,
}: {
  ctx: string;
  resource: Resource;
}) {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["k8s", "cronjob-manual-runs", ctx, resource.namespace, resource.name],
    queryFn: () =>
      k8s.listManualCronjobRuns(resource.namespace, resource.name, ctx || undefined),
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
  return (
    <Section title={`manual runs · ${data?.length ?? 0}`}>
      {isLoading ? (
        <div className="text-[11px] text-text-muted">loading…</div>
      ) : error ? (
        <div className="text-[11px] text-danger">
          {(error as Error).message ?? "failed to load manual runs"}
        </div>
      ) : !data || data.length === 0 ? (
        <div className="text-[11px] text-text-muted">
          no manual runs yet · use the ⚡ trigger button above to start one
        </div>
      ) : (
        <ul className="space-y-1">
          {data.map((run) => (
            <li
              key={run.name}
              className="flex items-center gap-2 rounded border border-border-subtle bg-elevated px-2 py-1.5"
            >
              <ManualRunStatusDot status={run.status} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11px] text-text-primary">
                  {run.name}
                </div>
                <div className="text-[10px] text-text-muted tabular-nums">
                  {run.started_at
                    ? `started ${formatRelativeFromAge(
                        Math.max(
                          0,
                          Math.floor((Date.now() - Date.parse(run.started_at)) / 1000),
                        ),
                      )}`
                    : "not started"}
                  {run.completed_at &&
                    ` · finished ${formatRelativeFromAge(
                      Math.max(
                        0,
                        Math.floor((Date.now() - Date.parse(run.completed_at)) / 1000),
                      ),
                    )}`}
                </div>
              </div>
              <span className="font-mono text-[10px] text-text-muted tabular-nums">
                {run.succeeded}/{run.succeeded + run.active + run.failed}
              </span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => refetch()}
        disabled={isFetching}
        className="mt-2 inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary disabled:opacity-50"
      >
        <Loader2 className={cn("size-3", isFetching && "animate-spin")} />
        refresh
      </button>
    </Section>
  );
}

function ManualRunStatusDot({ status }: { status: string }) {
  const tone =
    status === "Succeeded"
      ? "bg-success"
      : status === "Failed"
        ? "bg-danger"
        : status === "Active"
          ? "bg-warning animate-pulse"
          : "bg-text-muted";
  return (
    <span
      className={cn("size-2 shrink-0 rounded-full", tone)}
      title={status}
      aria-label={status}
    />
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

function hasResourceInsights(kind: WorkloadKind): boolean {
  return (
    kind === "service" ||
    kind === "ingress" ||
    kind === "networkpolicy" ||
    kind === "horizontalpodautoscaler" ||
    kind === "poddisruptionbudget" ||
    kind === "resourcequota" ||
    kind === "limitrange"
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
        <div className="text-[12px] text-text-secondary flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" /> loading RBAC details...
        </div>
      </Section>
    );
  }
  if (error || !data) {
    return (
      <Section title="rbac">
        <div className="text-[12px] text-danger flex items-center gap-2">
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
                        className="font-mono text-[11px] text-text-primary"
                      >
                        <span className="text-text-muted">{subject.kind}</span>{" "}
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
          <div className="text-[11px] text-text-muted">
            no readable policy rules found
          </div>
        ) : (
          <div className="space-y-2">
            {data.rules.map((rule, index) => (
              <div
                key={index}
                className="rounded-control border border-border-default bg-elevated px-2.5 py-2"
              >
                <div className="flex flex-wrap gap-1">
                  {rule.verbs.map((verb) => (
                    <span
                      key={verb}
                      className={cn(
                        "px-1.5 py-0.5 rounded border text-[10px] font-mono",
                        verb === "*" || verb === "delete" || verb === "deletecollection"
                          ? "border-danger/40 bg-[var(--status-error-soft)] text-danger"
                          : verb === "create" || verb === "patch" || verb === "update"
                            ? "border-warning/40 bg-[var(--status-warning-soft)] text-warning"
                            : "border-border-default bg-surface text-text-secondary",
                      )}
                    >
                      {verb}
                    </span>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
                  <span className="text-text-muted">api groups</span>
                  <span className="font-mono text-text-secondary break-all">
                    {rule.api_groups.join(", ")}
                  </span>
                  <span className="text-text-muted">resources</span>
                  <span className="font-mono text-text-primary break-all">
                    {rule.resources.join(", ")}
                  </span>
                  {rule.resource_names.length > 0 && (
                    <>
                      <span className="text-text-muted">names</span>
                      <span className="font-mono text-text-secondary break-all">
                        {rule.resource_names.join(", ")}
                      </span>
                    </>
                  )}
                  {rule.non_resource_urls.length > 0 && (
                    <>
                      <span className="text-text-muted">urls</span>
                      <span className="font-mono text-text-secondary break-all">
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
        <div className="text-[12px] text-text-secondary flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" /> loading storage details...
        </div>
      </Section>
    );
  }
  if (error || !data) {
    return (
      <Section title="storage">
        <div className="text-[12px] text-danger flex items-center gap-2">
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
                    <span className="text-text-muted">{key}</span>
                    <span className="text-text-secondary">=</span>
                    <span className="text-text-primary">{value}</span>
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

function ResourceInsightsSection({
  ctx,
  resource,
  kind,
}: {
  ctx: string;
  resource: Resource;
  kind: WorkloadKind;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["k8s", "resource-insights", ctx, resource.namespace, kind, resource.name],
    queryFn: () =>
      k8s.getResourceInsights(
        resource.namespace,
        kind,
        resource.name,
        ctx || undefined,
      ),
    staleTime: 10_000,
  });

  if (isLoading) {
    return (
      <Section title="insights">
        <div className="text-[12px] text-text-secondary flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" /> loading insights…
        </div>
      </Section>
    );
  }
  if (error || !data) {
    return (
      <Section title="insights">
        <div className="text-[12px] text-danger flex items-center gap-2">
          <AlertTriangle className="size-3.5" /> failed to load insights
        </div>
      </Section>
    );
  }

  return (
    <>
      {data.sections.map((insight) => (
        <Section key={insight.title} title={insight.title}>
          {insight.rows.length === 0 ? (
            <div className="text-[11px] text-text-muted">no details reported</div>
          ) : (
            <Dl>
              {insight.rows.map((row) => (
                <DlRow
                  key={`${insight.title}-${row.label}`}
                  label={row.label}
                  value={row.value || "—"}
                  mono
                />
              ))}
            </Dl>
          )}
        </Section>
      ))}
    </>
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
        <span className="text-[10px] uppercase tracking-wider text-text-muted">{title}</span>
        <span className="flex-1 border-t border-dashed border-border-subtle" />
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

// 240 samples × 15s poll = 1h of history per drawer mount. Was 60 (15min)
// pre-D9; bumped now that the query polls so the buffer actually fills.
const HISTORY_CAP = 240;

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
        stroke="text-success"
      />
      <SparklineTile
        label="memory"
        value={memBytes !== null ? formatBytes(memBytes) : "—"}
        history={memHist}
        stroke="text-warning"
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
    <div className="rounded-control border border-border-default bg-elevated p-3">
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[20px] font-mono tabular-nums text-text-primary">{value}</span>
        {suffix && <span className="text-[10px] text-text-secondary">{suffix}</span>}
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
      <div className={cn("text-[10px] text-text-muted", className)}>
        gathering data...
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
      <dt className="text-[11px] text-text-muted">{label}</dt>
      <dd
        className={cn(
          "text-[12px] text-text-primary break-all",
          mono && "font-mono tabular-nums",
        )}
      >
        {value}
      </dd>
    </>
  );
}

function StatusText({ status }: { status: string }) {
  return <StatusBadge status={status} />;
}

function ConditionPill({ type, status }: { type: string; status: string }) {
  const cls =
    status === "True"
      ? "border-success/30 text-success bg-[var(--status-success-soft)]"
      : status === "False"
        ? "border-danger/30 text-danger bg-[var(--status-error-soft)]"
        : "border-border-default text-text-secondary bg-elevated";
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
    return <span className="text-[11px] text-text-muted">no labels</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map(([k, v]) => (
        <span
          key={k}
          className="inline-flex items-center px-1.5 py-0.5 rounded bg-elevated border border-border-default text-[10px] text-text-secondary font-mono"
        >
          <span className="text-text-muted">{k}</span>
          <span className="text-text-muted">=</span>
          <span className="text-text-primary">{v}</span>
        </span>
      ))}
      {hidden > 0 && (
        <span className="px-1.5 py-0.5 text-[10px] text-text-muted">+{hidden} more</span>
      )}
    </div>
  );
}

// ─── Container chiclets (Lumen-distinct) ───────────────────────────────

function ContainerCard({ container: c }: { container: ContainerInfo }) {
  const stateColor = c.state.startsWith("Running")
    ? "bg-success"
    : c.state.startsWith("Waiting")
      ? "bg-warning"
      : c.state.startsWith("Terminated")
        ? "bg-danger"
        : "bg-border-default";
  return (
    <div className="rounded-control border border-border-default bg-elevated p-2.5">
      <div className="flex items-center gap-2">
        <span className={cn("size-2 rounded-full shrink-0", stateColor)} />
        <span className="text-[12px] text-text-primary font-medium font-mono truncate flex-1">
          {c.name}
        </span>
        {c.restart_count > 0 && (
          <span className="px-1 rounded bg-[var(--status-warning-soft)] text-warning text-[10px] border border-warning/30 tabular-nums">
            ↻ {c.restart_count}
          </span>
        )}
        <span className="text-[10px] text-text-muted">{c.state}</span>
      </div>
      <div className="mt-1 text-[11px] text-text-secondary font-mono truncate">{c.image}</div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-text-muted">
        <div className="flex justify-between">
          <span>cpu req</span>
          <span className="text-text-secondary font-mono tabular-nums">
            {c.cpu_request_milli !== null ? `${c.cpu_request_milli}m` : "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span>cpu lim</span>
          <span className="text-text-secondary font-mono tabular-nums">
            {c.cpu_limit_milli !== null ? `${c.cpu_limit_milli}m` : "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span>mem req</span>
          <span className="text-text-secondary font-mono tabular-nums">
            {c.mem_request_bytes !== null ? formatBytes(c.mem_request_bytes) : "—"}
          </span>
        </div>
        <div className="flex justify-between">
          <span>mem lim</span>
          <span className="text-text-secondary font-mono tabular-nums">
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
  const qc = useQueryClient();
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [draft, setDraft] = useState("");
  const [dryRunOutput, setDryRunOutput] = useState<string | null>(null);
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sensitive = resource.kind === "secret";
  const { data, isLoading, error } = useQuery({
    queryKey: ["k8s", "resource-yaml", ctx, resource.namespace, kind, resource.name],
    queryFn: () => k8s.getResource(resource.namespace, kind, resource.name, ctx),
    staleTime: 30_000,
  });
  const updateAccess = useQuery({
    queryKey: [
      "k8s",
      "access",
      ctx,
      resource.namespace,
      resource.kind,
      resource.name,
      "update",
    ],
    queryFn: () =>
      k8s.checkAccess(
        {
          kind,
          verb: "update",
          namespace: resource.namespace || null,
          name: resource.name,
        },
        ctx || undefined,
      ),
    enabled: !sensitive,
    staleTime: 15_000,
  });

  useEffect(() => {
    setMode("read");
    setDraft("");
    setDryRunOutput(null);
    setApplyErr(null);
    setApplyConfirmOpen(false);
  }, [ctx, resource.kind, resource.namespace, resource.name]);

  useEffect(() => {
    if (mode === "edit" && data?.yaml && !draft) setDraft(data.yaml);
  }, [mode, data?.yaml, draft]);

  const canEdit = !sensitive && updateAccess.data?.allowed === true;
  const dirty = mode === "edit" && draft !== (data?.yaml ?? "");

  async function copyYaml() {
    const text = mode === "edit" ? draft : (data?.yaml ?? "");
    if (!text) return;
    await navigator.clipboard.writeText(text);
    toast.success("YAML copied");
  }

  async function runApply(dryRun: boolean) {
    if (!canEdit || !data || !dirty || busy) return;
    setBusy(true);
    setApplyErr(null);
    setDryRunOutput(null);
    try {
      const out = await k8s.applyResource(
        resource.namespace,
        kind,
        resource.name,
        draft,
        dryRun,
        ctx || undefined,
      );
      if (dryRun) {
        setDryRunOutput(out.yaml);
        toast.success("dry-run ok — server validated");
      } else {
        toast.success(`applied ${resource.kind}/${resource.name}`);
        setDraft(out.yaml);
        setMode("read");
        setDryRunOutput(null);
        await qc.invalidateQueries({
          queryKey: [
            "k8s",
            "resource-yaml",
            ctx,
            resource.namespace,
            kind,
            resource.name,
          ],
        });
        await qc.invalidateQueries({ queryKey: ["k8s", "resource-meta"] });
        await qc.invalidateQueries({ queryKey: ["k8s", "workloads"] });
      }
    } catch (e) {
      setApplyErr((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) {
    return (
      <div className="p-4 text-[12px] text-text-secondary flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin" /> loading yaml...
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-4 text-[12px] text-danger flex items-center gap-2">
        <AlertTriangle className="size-3.5" />
        failed to load yaml
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-code-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
        <div className="min-w-0 flex-1 text-[11px] text-text-muted">
          server-side apply as <span className="font-mono text-text-secondary">lumen</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canEdit || updateAccess.isLoading}
          title={
            sensitive
              ? "secrets are read-only in the drawer"
              : updateAccess.data?.allowed === false
                ? "edit denied by RBAC"
                : undefined
          }
          onClick={() => {
            if (!canEdit) return;
            if (mode === "read") {
              setDraft(data.yaml ?? "");
              setMode("edit");
              requestAnimationFrame(() => textareaRef.current?.focus());
            } else {
              setMode("read");
              setDryRunOutput(null);
              setApplyErr(null);
            }
          }}
          className="h-7 gap-1.5 text-[11px]"
        >
          {mode === "read" ? (
            <>
              <Pencil className="size-3" /> edit
            </>
          ) : (
            <>
              <Eye className="size-3" /> view
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!data.yaml && !draft}
          onClick={() => void copyYaml()}
          className="h-7 gap-1.5 text-[11px]"
        >
          <Copy className="size-3" /> copy
        </Button>
        {mode === "edit" && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !dirty || !canEdit}
              onClick={() => void runApply(true)}
              className="h-7 gap-1.5 text-[11px]"
            >
              <FlaskConical className="size-3" /> dry-run
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={busy || !dirty || !canEdit}
              onClick={() => setApplyConfirmOpen(true)}
              className="h-7 gap-1.5 text-[11px]"
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              apply
            </Button>
          </>
        )}
      </div>

      {sensitive && (
        <div className="shrink-0 border-b border-warning/30 bg-[var(--status-warning-soft)] px-3 py-2 text-[11px] text-warning">
          sensitive values are redacted and this YAML is read-only.
        </div>
      )}

      {mode === "edit" ? (
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-code-surface p-4 font-mono text-[11px] leading-relaxed text-text-primary outline-none [font-feature-settings:'liga'_0,'calt'_0]"
        />
      ) : (
        <pre className="m-0 min-h-0 flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed text-text-primary whitespace-pre">
          {data.yaml}
        </pre>
      )}

      {applyErr && (
        <div className="shrink-0 border-t border-danger/40 bg-[var(--status-error-soft)] px-3 py-2 text-[11px] text-danger whitespace-pre-wrap">
          {applyErr}
        </div>
      )}
      {dryRunOutput && (
        <details className="shrink-0 border-t border-border-subtle bg-surface">
          <summary className="cursor-pointer select-none px-3 py-2 text-[11px] text-success">
            dry-run output
          </summary>
          <pre className="max-h-[220px] overflow-auto p-3 font-mono text-[11px] text-text-secondary whitespace-pre">
            {dryRunOutput}
          </pre>
        </details>
      )}

      <ConfirmActionDialog
        open={applyConfirmOpen}
        title={`apply ${resource.kind}`}
        description={`This server-side apply can create or update ${resource.kind}/${resource.name} in ${resource.namespace || "cluster scope"}. Dry-run first if you only want validation.`}
        target={`${resource.namespace || "cluster"}/${resource.name}`}
        confirmLabel="apply"
        intent="warning"
        busy={busy}
        onCancel={() => setApplyConfirmOpen(false)}
        onConfirm={() => {
          setApplyConfirmOpen(false);
          void runApply(false);
        }}
      />
    </div>
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
      <div className="p-4 text-[12px] text-text-secondary flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin" /> loading events...
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4 text-[12px] text-danger">failed to load events</div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <div className="p-4 text-[12px] text-text-secondary">no events for this resource.</div>
    );
  }
  return (
    <div className="p-2">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-text-muted text-left uppercase tracking-wide">
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
                "border-t border-border-subtle align-top",
                e.type_ === "Warning" && "bg-[var(--status-warning-soft)]/30",
              )}
            >
              <td className="px-2 py-1.5 text-text-secondary whitespace-nowrap font-mono">
                {e.ts ? formatRelative(Date.parse(e.ts)) : "—"}
              </td>
              <td className="px-2 py-1.5">
                <span
                  className={cn(
                    "inline-flex px-1 rounded text-[10px] border",
                    e.type_ === "Warning"
                      ? "text-warning border-warning/40 bg-[var(--status-warning-soft)]"
                      : "text-text-secondary border-border-default",
                  )}
                >
                  {e.type_}
                </span>
              </td>
              <td className="px-2 py-1.5 text-text-primary whitespace-nowrap">{e.reason}</td>
              <td className="px-2 py-1.5 text-text-secondary">{e.message}</td>
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
