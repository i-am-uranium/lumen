import { useConfirmationTarget } from "@/hooks/useConfirmationTarget";
import { AlertTriangle, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Intent = "danger" | "warning" | "primary";

type Props = {
  open: boolean;
  title: string;
  description: string;
  target: string;
  context?: string;
  namespace?: string;
  confirmLabel: string;
  busy?: boolean;
  intent?: Intent;
  confirmText?: string;
  onCancel: () => void;
  onConfirm: () => void;
};

const intentClasses: Record<Intent, string> = {
  danger: "border-danger/40 bg-danger/15 text-danger hover:bg-danger/20",
  warning: "border-warning/40 bg-warning/15 text-warning hover:bg-warning/20",
  primary: "border-accent-primary/40 bg-accent-primary-soft text-accent-primary",
};

export function ConfirmActionDialog({
  open,
  title,
  description,
  target,
  context: explicitContext,
  namespace,
  confirmLabel,
  busy = false,
  intent = "danger",
  confirmText = target,
  onCancel,
  onConfirm,
}: Props) {
  const [typed, setTyped] = useState("");
  const titleId = useId();
  const descId = useId();
  const { context, valid } = useConfirmationTarget(open, JSON.stringify([target, confirmText]), explicitContext, namespace, onCancel);
  const matches = valid && typed === confirmText;

  useEffect(() => {
    if (open) setTyped("");
  }, [open, confirmText]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-[520px] flex-col overflow-hidden rounded-panel border border-border-strong bg-surface shadow-[var(--shadow-popover)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-default px-4 py-3">
          <h2 id={titleId} className="flex items-center gap-2 text-[14px] font-semibold text-text-primary">
            {intent !== "primary" && <AlertTriangle className={cn("size-4", intent === "danger" ? "text-danger" : "text-warning")} />}
            {title}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-text-muted hover:text-text-primary"
            aria-label="cancel"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 space-y-4 overflow-auto p-4">
          <p id={descId} className="text-[12px] leading-5 text-text-secondary">
            {description}
          </p>
          <div className="rounded-control border border-border-default bg-shell p-3">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">
              target{context ? ` · context ${context}` : ""}{namespace !== undefined ? ` · namespace ${namespace || "cluster scope"}` : ""}
            </div>
            <div className="mt-1 max-h-32 overflow-auto break-all font-mono text-[12px] text-text-primary">
              {target}
            </div>
          </div>
          <label className="block">
            <span className="text-[11px] text-text-secondary">
              Type <span className="font-mono text-text-primary">{confirmText}</span> to confirm.
            </span>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-2 font-mono text-[12px]"
              aria-label="confirmation text"
              autoFocus
            />
          </label>
          <div className="sticky bottom-0 -mx-4 -mb-4 flex justify-end gap-2 border-t border-border-subtle bg-surface px-4 py-3">
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
              cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !matches}
              onClick={() => { if (matches && !busy) onConfirm(); }}
              className={intentClasses[intent]}
            >
              {busy ? "working..." : confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
