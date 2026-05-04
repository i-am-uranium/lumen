import { useEffect, useRef, useState } from "react";
import { Check, Copy, Eye, FlaskConical, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { k8s, type ApplyOutcome, type WorkloadKind } from "@/lib/k8s";
import { cn } from "@/lib/utils";

type EditCapability = {
  /** Namespace of the target. Required because apply_resource pins it server-side. */
  namespace: string;
  kind: WorkloadKind;
  name: string;
  context?: string;
  /** Called after a successful (non-dry-run) apply so the host can refresh
   * whatever depends on this resource's state. */
  onApplied?: (outcome: ApplyOutcome) => void;
};

type Props = {
  title: string;
  subtitle?: string;
  yaml: string | undefined;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  /** Turns on edit mode + Apply button. Omit for read-only (CrdBrowser). */
  editable?: EditCapability;
  /** Optional slot rendered in the header action row, left of edit/copy.
   * Callers typically pass a <PinButton /> so the resource can be pinned
   * without leaving the modal. */
  pinSlot?: React.ReactNode;
};

/** YAML inspector with optional server-side-apply editing. */
export function YamlModal({
  title,
  subtitle,
  yaml,
  loading,
  error,
  onClose,
  editable,
  pinSlot,
}: Props) {
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [draft, setDraft] = useState<string>("");
  const [dryRunOutput, setDryRunOutput] = useState<string | null>(null);
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Seed the draft when yaml loads / we enter edit mode.
  useEffect(() => {
    if (mode === "edit" && yaml && !draft) setDraft(yaml);
  }, [mode, yaml, draft]);

  // Reset when the modal is for a different resource.
  useEffect(() => {
    setMode("read");
    setDraft("");
    setDryRunOutput(null);
    setApplyErr(null);
  }, [title, subtitle]);

  const copy = async () => {
    const text = mode === "edit" ? draft : (yaml ?? "");
    if (!text) return;
    await navigator.clipboard.writeText(text);
    toast.success("YAML copied");
  };

  const runApply = async (dry: boolean) => {
    if (!editable) return;
    setBusy(true);
    setApplyErr(null);
    setDryRunOutput(null);
    try {
      const out = await k8s.applyResource(
        editable.namespace,
        editable.kind,
        editable.name,
        draft,
        dry,
        editable.context,
      );
      if (dry) {
        setDryRunOutput(out.yaml);
        toast.success("dry-run ok — server validated");
      } else {
        toast.success(`applied ${editable.kind}/${editable.name}`);
        editable.onApplied?.(out);
        // Refresh the visible YAML from the server and drop edit mode.
        setDraft(out.yaml);
        setMode("read");
        setDryRunOutput(null);
      }
    } catch (e) {
      setApplyErr((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const dirty = mode === "edit" && draft !== (yaml ?? "");

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-term-panel border border-term-border rounded-lg shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-term-border-soft shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[12px] text-term-muted font-mono">{title}</span>
            {subtitle && (
              <>
                <span className="text-term-subtle">·</span>
                <span className="text-[12px] text-term-fg truncate">{subtitle}</span>
              </>
            )}
            {mode === "edit" && (
              <span
                className={cn(
                  "ml-2 px-1.5 py-0.5 text-[10px] rounded border font-semibold uppercase tracking-wide",
                  dirty
                    ? "bg-amber-500/10 text-amber-300 border-amber-500/40"
                    : "bg-term-panel-2 text-term-subtle border-term-border-soft",
                )}
              >
                {dirty ? "modified" : "editing"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {pinSlot}
            {editable && (
              <button
                onClick={() => {
                  if (mode === "read") {
                    setDraft(yaml ?? "");
                    setMode("edit");
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  } else {
                    setMode("read");
                    setDryRunOutput(null);
                    setApplyErr(null);
                  }
                }}
                className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px]"
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
              </button>
            )}
            <button
              onClick={copy}
              disabled={!yaml && !draft}
              className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px] disabled:opacity-50"
            >
              <Copy className="size-3" /> copy
            </button>
            <button onClick={onClose} className="text-term-subtle hover:text-term-fg">
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          {error ? (
            <pre className="p-4 text-[12px] text-term-red whitespace-pre-wrap">{error}</pre>
          ) : loading ? (
            <div className="p-4 text-[12px] text-term-muted">loading…</div>
          ) : mode === "edit" ? (
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="flex-1 min-h-0 p-4 text-[12px] font-mono leading-relaxed bg-term-bg text-term-fg outline-none resize-none [font-feature-settings:'liga'_0,'calt'_0]"
            />
          ) : (
            <pre className="flex-1 overflow-auto p-4 text-[12px] text-term-fg font-mono leading-relaxed whitespace-pre">
              {yaml}
            </pre>
          )}
          {applyErr && (
            <div className="px-4 py-2 text-[12px] text-term-red border-t border-term-red/40 bg-term-red/10 whitespace-pre-wrap">
              {applyErr}
            </div>
          )}
          {dryRunOutput && (
            <details className="border-t border-term-border-soft">
              <summary className="px-4 py-2 text-[11px] text-term-green cursor-pointer select-none">
                dry-run output (click to expand)
              </summary>
              <pre className="max-h-[220px] overflow-auto p-4 text-[11px] text-term-muted font-mono whitespace-pre bg-term-bg">
                {dryRunOutput}
              </pre>
            </details>
          )}
        </div>

        {editable && mode === "edit" && (
          <div className="px-4 py-3 border-t border-term-border-soft flex justify-end gap-2 shrink-0">
            <span className="mr-auto text-[11px] text-term-subtle self-center">
              Server-side apply as field manager{" "}
              <span className="font-mono text-term-muted">lumen</span> · force=true
            </span>
            <button
              onClick={() => runApply(true)}
              disabled={busy || !dirty}
              className="term-btn !min-h-[30px] !text-[11px] disabled:opacity-50"
            >
              <FlaskConical className="size-3" /> dry-run
            </button>
            <button
              onClick={() => runApply(false)}
              disabled={busy || !dirty}
              className="term-btn term-btn-primary !min-h-[30px] !text-[11px] disabled:opacity-50"
            >
              <Check className="size-3" /> {busy ? "applying…" : "apply"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
