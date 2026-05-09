import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  PreflightImpact,
  PreflightRiskLevel,
  ServiceRisk,
} from "@/lib/preflight";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  title: string;
  description?: string;
  impact: PreflightImpact | null;
  confirmLabel: string;
  confirmText: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

const riskClasses: Record<PreflightRiskLevel, string> = {
  low: "border-success/35 bg-success-soft text-success",
  medium: "border-warning/40 bg-warning-soft text-warning",
  high: "border-danger/45 bg-[var(--status-error-soft)] text-danger",
};

const confirmClasses: Record<PreflightRiskLevel, string> = {
  low: "border-success/40 bg-success-soft text-success hover:bg-success-soft/80",
  medium: "border-warning/40 bg-warning/15 text-warning hover:bg-warning/20",
  high: "border-danger/40 bg-danger/15 text-danger hover:bg-danger/20",
};

export function PreflightPreviewDialog({
  open,
  title,
  description,
  impact,
  confirmLabel,
  confirmText,
  busy = false,
  onCancel,
  onConfirm,
}: Props) {
  const [typed, setTyped] = useState("");
  const [highRiskTyped, setHighRiskTyped] = useState("");
  const titleId = useId();
  const descId = useId();
  const risk = impact?.riskLevel ?? "medium";
  const targetMatches = typed === confirmText;
  const highRiskMatches = !impact?.requiresExplicitConfirm || highRiskTyped === "HIGH RISK";
  const canConfirm = !!impact && targetMatches && highRiskMatches && !busy;
  const warningRows = impact?.warnings ?? [];
  const diffRows = impact?.diffs ?? [];
  const facts = useMemo(() => {
    if (!impact) return [];
    return [
      ["action", impact.actionType],
      ["target", impact.targetLabel],
      ["namespace", impact.namespace || "cluster scope"],
      ["resources", String(impact.affectedResourceCount)],
      ["pod churn", impact.podChurn.summary],
      ["service/endpoints", formatServiceRisk(impact.serviceRisk)],
    ];
  }, [impact]);

  useEffect(() => {
    if (!open) return;
    setTyped("");
    setHighRiskTyped("");
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
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-[680px] flex-col overflow-hidden rounded-panel border border-border-strong bg-surface shadow-[var(--shadow-popover)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-default px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="flex items-center gap-2 text-[14px] font-semibold text-text-primary">
              <AlertTriangle
                className={cn(
                  "size-4",
                  risk === "high"
                    ? "text-danger"
                    : risk === "medium"
                      ? "text-warning"
                      : "text-success",
                )}
              />
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-[11px] leading-5 text-text-secondary">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-text-muted hover:text-text-primary disabled:opacity-50"
            aria-label="cancel"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 space-y-4 overflow-auto p-4">
          {!impact ? (
            <div className="flex items-center gap-2 rounded-control border border-border-default bg-shell p-3 text-[12px] text-text-secondary">
              <Loader2 className="size-3.5 animate-spin" />
              building preflight preview...
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Metric label="risk" value={impact.riskLevel} tone={impact.riskLevel} />
                <Metric
                  label="resources"
                  value={String(impact.affectedResourceCount)}
                  tone="low"
                />
                <Metric
                  label="pod churn"
                  value={impact.podChurn.level}
                  tone={impact.podChurn.level === "high" ? "high" : impact.podChurn.level === "none" ? "low" : "medium"}
                />
              </div>

              <div className="rounded-control border border-border-default bg-shell p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {facts.map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <div className="text-[10px] uppercase tracking-wider text-text-muted">
                        {label}
                      </div>
                      <div className="mt-1 break-words font-mono text-[12px] text-text-primary">
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  notable changes
                </h3>
                {diffRows.length === 0 ? (
                  <EmptyRow>No notable YAML diffs detected locally.</EmptyRow>
                ) : (
                  <div className="space-y-2">
                    {diffRows.map((diff, index) => (
                      <div
                        key={`${diff.category}-${index}`}
                        className="rounded-control border border-border-default bg-elevated p-2"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                              riskClasses[diff.severity],
                            )}
                          >
                            {diff.category}
                          </span>
                          <span className="text-[12px] font-medium text-text-primary">
                            {diff.label}
                          </span>
                        </div>
                        {(diff.before || diff.after) && (
                          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <DiffValue label="before" value={diff.before} />
                            <DiffValue label="after" value={diff.after} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  safety notes
                </h3>
                {warningRows.length === 0 ? (
                  <EmptyRow>No warnings from local preflight checks.</EmptyRow>
                ) : (
                  <div className="space-y-1.5">
                    {warningRows.map((warning, index) => (
                      <div
                        key={`${warning.message}-${index}`}
                        className={cn(
                          "flex items-start gap-2 rounded-control border px-2 py-1.5 text-[12px]",
                          riskClasses[warning.severity],
                        )}
                      >
                        {warning.severity === "low" ? (
                          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                        ) : (
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        )}
                        <span>{warning.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <div className="space-y-3 rounded-control border border-border-default bg-shell p-3">
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
                {impact.requiresExplicitConfirm && (
                  <label className="block">
                    <span className="text-[11px] text-danger">
                      High-risk change: type <span className="font-mono text-text-primary">HIGH RISK</span>.
                    </span>
                    <Input
                      value={highRiskTyped}
                      onChange={(e) => setHighRiskTyped(e.target.value)}
                      className="mt-2 font-mono text-[12px]"
                      aria-label="high risk confirmation"
                    />
                  </label>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border-subtle bg-surface px-4 py-3">
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
            cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canConfirm}
            onClick={onConfirm}
            className={confirmClasses[risk]}
          >
            {busy ? "working..." : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: PreflightRiskLevel;
}) {
  return (
    <div className={cn("rounded-control border p-2", riskClasses[tone])}>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="mt-1 font-mono text-[13px] font-semibold">{value}</div>
    </div>
  );
}

function DiffValue({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0 rounded border border-border-subtle bg-code-surface p-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-text-secondary">
        {value || "none"}
      </pre>
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-control border border-border-default bg-shell px-3 py-2 text-[12px] text-text-secondary">
      {children}
    </div>
  );
}

function formatServiceRisk(risk: ServiceRisk): string {
  switch (risk) {
    case "selector-or-port-change":
      return "selector or port change detected";
    case "possible-endpoint-change":
      return "possible endpoint impact";
    case "none":
      return "no service/endpoints risk detected";
  }
}
