import { useEffect, useMemo, useState } from "react";
import { Copy, Download, FileDown, Loader2, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  buildIncidentReportData,
  incidentReportFilename,
  renderIncidentReportMarkdown,
  type IncidentReportInput,
} from "@/lib/incidentReport";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  input: Omit<IncidentReportInput, "generatedAt" | "manualNotes">;
  loading?: boolean;
  error?: Error | null;
  onClose: () => void;
};

export function IncidentReportDialog({
  open,
  input,
  loading = false,
  error = null,
  onClose,
}: Props) {
  const [manualNotes, setManualNotes] = useState("");
  const [generatedAt, setGeneratedAt] = useState(() => new Date());
  const [busyAction, setBusyAction] = useState<"copy" | "download" | null>(null);

  useEffect(() => {
    if (!open) return;
    setGeneratedAt(new Date());
    setBusyAction(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  const report = useMemo(
    () =>
      buildIncidentReportData({
        ...input,
        generatedAt,
        manualNotes,
      }),
    [generatedAt, input, manualNotes],
  );
  const markdown = useMemo(() => renderIncidentReportMarkdown(report), [report]);
  const filename = useMemo(
    () =>
      incidentReportFilename({
        ...input,
        generatedAt,
      }),
    [generatedAt, input],
  );
  const hasCapturedContext =
    report.summary.totalIssues > 0 ||
    report.summary.warningEvents > 0 ||
    report.summary.rolloutNotes > 0 ||
    report.scope.selectedResource !== "none" ||
    report.manualNotes.length > 0;
  const canExport = !loading && !error && hasCapturedContext;

  async function copyMarkdown() {
    if (!canExport) return;
    setBusyAction("copy");
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success("Incident report copied");
    } catch (err) {
      toast.error((err as Error).message || "Clipboard write failed");
    } finally {
      setBusyAction(null);
    }
  }

  function downloadMarkdown() {
    if (!canExport) return;
    setBusyAction("download");
    try {
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      toast.success("Incident report downloaded");
    } catch (err) {
      toast.error((err as Error).message || "Download failed");
    } finally {
      setBusyAction(null);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="incident-report-title"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-[920px] flex-col overflow-hidden rounded-panel border border-border-strong bg-surface shadow-[var(--shadow-popover)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border-default px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <FileDown className="size-4 text-accent-primary" aria-hidden="true" />
              <h2 id="incident-report-title" className="text-sm font-semibold text-text-primary">
                Incident report export
              </h2>
              <span className="inline-flex items-center gap-1 rounded border border-success/35 bg-success-soft px-1.5 py-0.5 text-[10px] text-success">
                <ShieldCheck className="size-3" aria-hidden="true" />
                redacted
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-text-muted">
              {filename}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-elevated hover:text-text-primary"
            aria-label="close incident report export"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="border-b border-border-default p-4 lg:border-b-0 lg:border-r">
            <div className="grid grid-cols-2 gap-2">
              <ReportMetric label="issues" value={report.summary.totalIssues} />
              <ReportMetric label="warnings" value={report.summary.warningEvents} />
              <ReportMetric label="critical" value={report.summary.critical} tone="danger" />
              <ReportMetric label="rollouts" value={report.summary.rolloutNotes} />
            </div>

            <label className="mt-4 block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
              manual notes
            </label>
            <textarea
              value={manualNotes}
              onChange={(event) => setManualNotes(event.target.value)}
              placeholder="Add timeline notes, observed symptoms, owner handoff, or remediation notes..."
              spellCheck={false}
              className="mt-2 h-44 w-full resize-none rounded-control border border-border-subtle bg-code-surface p-2 font-mono text-[12px] text-text-primary outline-none focus:border-accent-primary/50"
            />

            <div className="mt-4 space-y-2">
              <Button
                type="button"
                className="w-full justify-center"
                onClick={copyMarkdown}
                disabled={!canExport || busyAction !== null}
              >
                {busyAction === "copy" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                copy Markdown
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full justify-center"
                onClick={downloadMarkdown}
                disabled={!canExport || busyAction !== null}
              >
                {busyAction === "download" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                download .md
              </Button>
            </div>
          </aside>

          <div className="min-h-0 overflow-auto p-4">
            {error ? (
              <StatePanel tone="danger" title="Report context failed" body={error.message} />
            ) : loading ? (
              <StatePanel
                title="Building report context"
                body="Workloads, nodes, and warning events are still loading."
                loading
              />
            ) : !hasCapturedContext ? (
              <StatePanel
                title="No report context captured"
                body="No triage issues, warning events, selected resource, rollout notes, or manual notes are available yet."
              />
            ) : (
              <pre className="min-h-[480px] whitespace-pre-wrap rounded-control border border-border-subtle bg-code-surface p-3 font-mono text-[11px] leading-5 text-text-primary">
                {markdown}
              </pre>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function ReportMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "danger";
}) {
  return (
    <div
      className={cn(
        "rounded-control border bg-elevated px-3 py-2",
        tone === "danger" && value > 0
          ? "border-danger/35 bg-[var(--status-error-soft)]"
          : "border-border-default",
      )}
    >
      <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted">
        {label}
      </div>
      <div className="mt-1 font-mono text-lg font-semibold text-text-primary">
        {value}
      </div>
    </div>
  );
}

function StatePanel({
  title,
  body,
  loading = false,
  tone = "neutral",
}: {
  title: string;
  body: string;
  loading?: boolean;
  tone?: "neutral" | "danger";
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-panel border p-4 text-sm",
        tone === "danger"
          ? "border-danger/35 bg-[var(--status-error-soft)] text-danger"
          : "border-border-default bg-elevated text-text-secondary",
      )}
    >
      {loading ? <Loader2 className="mt-0.5 size-4 animate-spin" /> : null}
      <div>
        <div className="font-medium text-text-primary">{title}</div>
        <div className="mt-1 text-[12px] leading-5">{body}</div>
      </div>
    </div>
  );
}
