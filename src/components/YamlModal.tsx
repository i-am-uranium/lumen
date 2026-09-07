import { useMutationCapability } from "@/hooks/useMutationCapability";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Eye, FlaskConical, Pencil, ShieldOff, X } from "lucide-react";
import { toast } from "sonner";
import { k8s, type ApplyOutcome, type WorkloadKind } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { PreflightPreviewDialog } from "@/components/PreflightPreviewDialog";
import { analyzeYamlPreflight } from "@/lib/preflight";
import { summarizeSmartYamlDiff } from "@/lib/smartDiff";
import { useUiSettings } from "@/state/uiSettings";

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
  /** The YAML has had sensitive fields removed and must not be applied back. */
  sensitive?: boolean;
  /** Share the same editor and safety checks inside a resource drawer. */
  embedded?: boolean;
};

/** YAML inspector with optional server-side-apply editing. */
export function YamlModal(props: Props) {
  const readOnly = useUiSettings((s) => s.readOnly);
  // A target change must discard the draft, validation, confirmations, and
  // in-flight responses even when two clusters have identically named objects.
  const key = JSON.stringify([
    props.title, props.subtitle, props.sensitive, readOnly,
    props.editable?.context, props.editable?.namespace,
    props.editable?.kind, props.editable?.name,
  ]);
  return <YamlModalContent key={key} {...props} editable={readOnly ? undefined : props.editable} />;
}

function YamlModalContent({
  title,
  subtitle,
  yaml,
  loading,
  error,
  onClose,
  editable,
  pinSlot,
  sensitive = false,
  embedded = false,
}: Props) {
  const capability = useMutationCapability(editable?.context);
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [draft, setDraft] = useState<string>("");
  const [dryRunOutput, setDryRunOutput] = useState<string | null>(null);
  const [applyErr, setApplyErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [validatedDraft, setValidatedDraft] = useState<string | null>(null);
  const operation = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current++; };
  }, []);

  function changeDraft(next: string) {
    if (applying) return;
    operation.current++;
    inFlight.current = false;
    setBusy(false);
    setDraft(next);
    setValidatedDraft(null);
    setDryRunOutput(null);
    setApplyErr(null);
    setApplyConfirmOpen(false);
  }
  const updateAccess = useQuery({
    queryKey: [
      "k8s",
      "access",
      editable?.context,
      editable?.namespace,
      editable?.kind,
      editable?.name,
      "patch",
    ],
    queryFn: () =>
      k8s.checkAccess(
        {
          kind: editable!.kind,
          verb: "patch",
          namespace: editable!.namespace || null,
          name: editable!.name,
        },
        editable!.context,
      ),
    enabled: !!editable && !sensitive,
    staleTime: 15_000,
  });
  const editCapability = sensitive ? undefined : editable;
  const canEdit = !!editCapability && updateAccess.data?.allowed === true && !!yaml && !loading && !error;

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
    setApplyConfirmOpen(false);
  }, [title, subtitle]);

  const copy = async () => {
    const text = mode === "edit" ? draft : (yaml ?? "");
    if (!text) return;
    await navigator.clipboard.writeText(text);
    toast.success("YAML copied");
  };

  const runApply = async (dry: boolean) => {
    if (!editable || sensitive || useUiSettings.getState().readOnly || !canEdit || inFlight.current) return;
    if (!dry && (!capability.canMutate || validatedDraft !== draft)) return;
    const submittedDraft = dry ? draft : validatedDraft!;
    const target = { ...editable };
    const request = ++operation.current;
    const isCurrent = () => mounted.current && operation.current === request;
    inFlight.current = true;
    setBusy(true);
    setApplying(!dry);
    setApplyErr(null);
    if (dry) {
      setValidatedDraft(null);
      setDryRunOutput(null);
    }
    try {
      const out = await k8s.applyResource(
        target.namespace, target.kind, target.name, submittedDraft, dry, target.context,
      );
      if (!isCurrent()) return;
      if (dry) {
        setValidatedDraft(submittedDraft);
        setDryRunOutput(out.yaml);
        toast.success("dry-run ok — server validated");
      } else {
        toast.success(`applied ${target.kind}/${target.name}`);
        target.onApplied?.(out);
        setDraft(out.yaml);
        setMode("read");
        setValidatedDraft(null);
        setDryRunOutput(null);
      }
    } catch (e) {
      if (!isCurrent()) return;
      setValidatedDraft(null);
      setDryRunOutput(null);
      setApplyErr((e as Error).message ?? String(e));
    } finally {
      if (isCurrent()) {
        inFlight.current = false;
        setBusy(false);
        setApplying(false);
      }
    }
  };

  const dirty = mode === "edit" && draft !== (yaml ?? "");
  const smartDiff = dryRunOutput ? summarizeSmartYamlDiff(yaml ?? "", dryRunOutput) : null;
  const applyPreflight = useMemo(() => {
    if (!editCapability) return null;
    return analyzeYamlPreflight({
      actionType: "apply",
      target: {
        kind: editCapability.kind,
        namespace: editCapability.namespace || null,
        name: editCapability.name,
      },
      beforeYaml: yaml ?? "",
      afterYaml: draft,
    });
  }, [draft, editCapability, yaml]);

  return (
    <div
      className={embedded ? "flex h-full min-h-0 flex-col" : "fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8"}
      onClick={embedded ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={embedded ? "bg-code-surface flex h-full min-h-0 flex-col" : "bg-term-panel border border-term-border rounded-lg shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col"}
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
                    ? "bg-warning-soft text-warning border-warning/40"
                    : "bg-term-panel-2 text-term-subtle border-term-border-soft",
                )}
              >
                {dirty ? "modified" : "editing"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {pinSlot}
            {editCapability && (
              <button
                onClick={() => {
                  if (!canEdit) return;
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
                disabled={busy || !canEdit || updateAccess.isLoading}
                title={
                  updateAccess.data?.allowed === false
                    ? "edit denied by RBAC"
                    : undefined
                }
                className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px] disabled:opacity-50"
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
            {!embedded && <button onClick={onClose} aria-label="Close YAML" className="text-term-subtle hover:text-term-fg">
              <X className="size-4" />
            </button>}
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
              disabled={applying}
              onChange={(e) => changeDraft(e.target.value)}
              spellCheck={false}
              className="flex-1 min-h-0 p-4 text-[12px] font-mono leading-relaxed bg-term-bg text-term-fg outline-none resize-none [font-feature-settings:'liga'_0,'calt'_0]"
            />
          ) : (
            <pre className="flex-1 overflow-auto p-4 text-[12px] text-term-fg font-mono leading-relaxed whitespace-pre">
              {yaml}
            </pre>
          )}
          {sensitive && mode === "read" && !loading && !error && (
            <div className="px-4 py-2 text-[12px] text-warning border-t border-warning/30 bg-warning-soft flex items-center gap-2">
              <ShieldOff className="size-3.5 shrink-0" />
              <span>sensitive values are redacted and this YAML is read-only.</span>
            </div>
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
              {smartDiff && <div className="px-4 py-2 text-[11px] text-term-muted">
                {smartDiff.isNoOp ? "no operationally meaningful changes detected" :
                  smartDiff.changes.slice(0, 6).map((change) => <div key={`${change.category}-${change.path}`}>
                    {change.category}: {change.path} ({change.before ?? "empty"} → {change.after ?? "empty"})
                  </div>)}
              </div>}
              <pre className="max-h-[220px] overflow-auto p-4 text-[11px] text-term-muted font-mono whitespace-pre bg-term-bg">
                {dryRunOutput}
              </pre>
            </details>
          )}
        </div>

        {editCapability && mode === "edit" && (
          <div className="px-4 py-3 border-t border-term-border-soft flex justify-end gap-2 shrink-0">
            <span className="mr-auto text-[11px] text-term-subtle self-center">
              Server-side apply as field manager{" "}
              <span className="font-mono text-term-muted">lumen</span> · dry-run required
            </span>
            <button
              onClick={() => runApply(true)}
              disabled={busy || !dirty || !canEdit}
              className="term-btn !min-h-[30px] !text-[11px] disabled:opacity-50"
            >
              <FlaskConical className="size-3" /> dry-run
            </button>
            <button
              onClick={() => setApplyConfirmOpen(true)}
              disabled={busy || !dirty || !canEdit || validatedDraft !== draft || !capability.canMutate}
              title={!capability.canMutate ? capability.reason : undefined}
              className="term-btn term-btn-primary !min-h-[30px] !text-[11px] disabled:opacity-50"
            >
              <Check className="size-3" /> {busy ? "applying…" : "apply"}
            </button>
          </div>
        )}
        {editCapability && (
          <PreflightPreviewDialog
            context={editable?.context}
            open={applyConfirmOpen}
            title={`preflight apply ${editCapability.kind}`}
            description={`This server-side apply can create or update ${editCapability.kind}/${editCapability.name} in ${editCapability.namespace || "cluster scope"}. The current draft passed server dry-run. Field ownership conflicts will block apply.`}
            impact={applyPreflight}
            confirmText={`${editCapability.namespace || "cluster"}/${editCapability.name}`}
            confirmLabel="apply"
            busy={busy || !capability.canMutate}
            onCancel={() => setApplyConfirmOpen(false)}
            onConfirm={() => {
              setApplyConfirmOpen(false);
              void runApply(false);
            }}
          />
        )}
      </div>
    </div>
  );
}
