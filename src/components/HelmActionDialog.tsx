import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { X, Loader2, CheckCircle2, AlertCircle, Terminal } from "lucide-react";
import { toast } from "sonner";
import {
  k8s,
  type HelmEvent,
  type HelmInstallRequest,
  type HelmUpgradeRequest,
} from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { useChangeHistoryStore } from "@/state/changeHistory";
import type {
  ChangeHistoryAction,
  ChangeHistoryStatus,
} from "@/lib/changeHistory";

export type HelmDialogAction =
  | { kind: "rollback"; release: string; namespace: string; revision: number; wait: boolean }
  | { kind: "uninstall"; release: string; namespace: string; keepHistory: boolean }
  | { kind: "install"; request: HelmInstallRequest }
  | { kind: "upgrade"; request: HelmUpgradeRequest };

// Backwards-compatible alias used by HelmBrowser.
type Action = HelmDialogAction;

// Streams `helm rollback` / `helm uninstall` output to a scrollable log pane,
// invalidates the release list on completion so the UI reflects the new
// state immediately. We intentionally surface `helm` failures verbatim
// (status & message) rather than translating them — the underlying CLI
// errors are the authoritative debugging artifact.
export function HelmActionDialog({
  action,
  context,
  onClose,
  onSuccess,
}: {
  action: Action;
  context: string;
  onClose: () => void;
  /** Optional callback fired after a successful exit (code === 0). */
  onSuccess?: () => void;
}) {
  const qc = useQueryClient();
  const [running, setRunning] = useState(true);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [lines, setLines] = useState<{ stream: "out" | "err"; line: string }[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const streamId = `helm-${action.kind}-${Date.now().toString(36)}`;
    const ch = new Channel<HelmEvent>();
    ch.onmessage = (ev) => {
      if (ev.kind === "stdout") {
        setLines((ls) => [...ls, { stream: "out", line: ev.line }]);
      } else if (ev.kind === "stderr") {
        setLines((ls) => [...ls, { stream: "err", line: ev.line }]);
      } else if (ev.kind === "exited") {
        setRunning(false);
        setExitCode(ev.code);
        recordHelmHistory(action, context, ev.code === 0 ? "success" : "failure", ev.code);
        if (ev.code === 0) {
          toast.success(`helm ${action.kind} succeeded`);
          qc.invalidateQueries({ queryKey: ["k8s", "helm"] });
          qc.invalidateQueries({ queryKey: ["k8s", "helm-detail"] });
          qc.invalidateQueries({ queryKey: ["k8s", "helm-history"] });
          onSuccess?.();
        } else {
          toast.error(`helm ${action.kind} failed (exit ${ev.code})`);
        }
      } else if (ev.kind === "error") {
        setLines((ls) => [...ls, { stream: "err", line: `lumen: ${ev.message}` }]);
      }
    };

    let promise: Promise<unknown>;
    switch (action.kind) {
      case "rollback":
        promise = k8s.helmRollback(
          {
            release: action.release,
            namespace: action.namespace,
            revision: action.revision,
            wait: action.wait,
          },
          streamId,
          ch,
          context || undefined,
        );
        break;
      case "uninstall":
        promise = k8s.helmUninstall(
          {
            release: action.release,
            namespace: action.namespace,
            keep_history: action.keepHistory,
          },
          streamId,
          ch,
          context || undefined,
        );
        break;
      case "install":
        promise = k8s.helmInstall(action.request, streamId, ch, context || undefined);
        break;
      case "upgrade":
        promise = k8s.helmUpgrade(action.request, streamId, ch, context || undefined);
        break;
    }

    promise.catch((e: unknown) => {
      setRunning(false);
      setExitCode(-1);
      recordHelmHistory(action, context, "failure", -1, e);
      setLines((ls) => [
        ...ls,
        { stream: "err", line: `lumen: ${(e as Error).message ?? e}` },
      ]);
    });
    // onSuccess is intentionally not in deps — captured at mount time on
    // purpose; the dialog is keyed by action so a re-render means a new run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, context, qc]);

  // Auto-scroll the log pane as new lines arrive.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const title =
    action.kind === "rollback"
      ? `rollback ${action.release} → revision ${action.revision}`
      : action.kind === "uninstall"
        ? `uninstall ${action.release}`
        : action.kind === "install"
          ? `install ${action.request.release}`
          : `upgrade ${action.request.release}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-3xl max-h-[80vh] flex flex-col rounded-lg border border-term-border-soft bg-term-panel shadow-xl">
        <header className="flex items-center justify-between px-4 py-3 border-b border-term-border-soft">
          <div className="flex items-center gap-2">
            <Terminal className="size-4 text-term-muted" />
            <span className="text-[13px] text-term-fg font-medium">{title}</span>
            {running ? (
              <span className="ml-2 text-[11px] text-term-amber inline-flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" /> running
              </span>
            ) : exitCode === 0 ? (
              <span className="ml-2 text-[11px] text-term-green inline-flex items-center gap-1">
                <CheckCircle2 className="size-3" /> done
              </span>
            ) : (
              <span className="ml-2 text-[11px] text-term-red inline-flex items-center gap-1">
                <AlertCircle className="size-3" /> exit {exitCode}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            disabled={running}
            className="p-1 text-term-muted hover:text-term-fg disabled:opacity-50 disabled:cursor-not-allowed"
            title={running ? "wait for command to finish" : "close"}
          >
            <X className="size-4" />
          </button>
        </header>

        <div
          ref={logRef}
          className="flex-1 min-h-0 overflow-auto p-3 font-mono text-[12px] leading-relaxed bg-term-bg whitespace-pre-wrap break-words"
        >
          {lines.length === 0 ? (
            <div className="text-term-subtle">starting…</div>
          ) : (
            lines.map((l, i) => (
              <div
                key={i}
                className={cn(l.stream === "err" && "text-term-amber")}
              >
                {l.line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function recordHelmHistory(
  action: Action,
  context: string,
  status: ChangeHistoryStatus,
  exitCode: number,
  error?: unknown,
) {
  const auditAction: ChangeHistoryAction = `helm-${action.kind}` as ChangeHistoryAction;
  const namespace =
    action.kind === "install" || action.kind === "upgrade"
      ? action.request.namespace
      : action.namespace;
  const release =
    action.kind === "install" || action.kind === "upgrade"
      ? action.request.release
      : action.release;
  const details =
    action.kind === "install" || action.kind === "upgrade"
      ? {
          chart: action.request.chart,
          version: action.request.version ?? "",
          dryRun: action.request.dry_run ?? false,
          exitCode,
        }
      : action.kind === "rollback"
        ? {
            revision: action.revision,
            wait: action.wait,
            exitCode,
          }
        : { keepHistory: action.keepHistory, exitCode };

  useChangeHistoryStore.getState().recordEvent({
    action: auditAction,
    target: {
      context,
      namespace,
      kind: "helmrelease",
      name: release,
    },
    status,
    summary:
      action.kind === "rollback"
        ? `helm rollback ${release} to revision ${action.revision}`
        : `helm ${action.kind} ${release}`,
    details,
    error: error ?? (status === "failure" ? `helm exited ${exitCode}` : undefined),
  });
}
