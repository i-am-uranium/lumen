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
  const matches = typed === confirmText;

  useEffect(() => {
    if (open) setTyped("");
  }, [open, confirmText]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="w-full max-w-[440px] rounded-panel border border-border-default bg-surface shadow-[var(--shadow-popover)]"
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
        <div className="space-y-4 p-4">
          <p id={descId} className="text-[12px] leading-5 text-text-secondary">
            {description}
          </p>
          <div className="rounded-control border border-border-default bg-shell p-3">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">
              target
            </div>
            <div className="mt-1 break-all font-mono text-[12px] text-text-primary">
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
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
              cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !matches}
              onClick={onConfirm}
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
