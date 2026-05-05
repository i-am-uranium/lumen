import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { k8s } from "@/lib/k8s";
import { cn } from "@/lib/utils";

type Resource = { kind: string; namespace: string; name: string };

/**
 * Cross-cluster compare dialog (D11 / C5).
 *
 * Picks a target context (defaulting to "first other reachable context"),
 * fetches the same kind/name there, and shows side-by-side YAML.
 *
 * v1 deliberately stays text-only — no inline diff highlighting. The
 * intent is "is staging the same as prod?", which side-by-side answers
 * adequately. Future iteration can pull in the `diff` package for
 * line-level highlighting.
 *
 * Lazy-loaded from {@link ResourceDetailDrawer}: pulls in two extra
 * useQuery instances + the line-set diff, so it stays out of the
 * workloads route chunk until a user opens the compare action.
 */
export function CompareAcrossClustersDialog({
  resource,
  sourceCtx,
  onClose,
}: {
  resource: Resource;
  sourceCtx: string;
  onClose: () => void;
}) {
  const { data: contexts = [] } = useQuery({
    queryKey: ["k8s", "contexts"],
    queryFn: k8s.listContexts,
    staleTime: 30_000,
  });
  const otherContexts = contexts.filter((c) => c.name !== sourceCtx);
  const [targetCtx, setTargetCtx] = useState<string>("");

  // Effect: prefer first non-source context as default once they load.
  useEffect(() => {
    if (!targetCtx && otherContexts.length > 0) {
      setTargetCtx(otherContexts[0].name);
    }
  }, [otherContexts, targetCtx]);

  const kind = resource.kind as Parameters<typeof k8s.getResource>[1];
  const sourceQuery = useQuery({
    queryKey: [
      "k8s",
      "compare-src",
      sourceCtx,
      resource.namespace,
      kind,
      resource.name,
    ],
    queryFn: () =>
      k8s.getResource(resource.namespace, kind, resource.name, sourceCtx),
    staleTime: 5_000,
  });
  const targetQuery = useQuery({
    queryKey: [
      "k8s",
      "compare-tgt",
      targetCtx,
      resource.namespace,
      kind,
      resource.name,
    ],
    queryFn: () =>
      k8s.getResource(resource.namespace, kind, resource.name, targetCtx),
    enabled: !!targetCtx,
    staleTime: 5_000,
  });

  // Quick line-set delta — counts lines unique to one side. Not a real
  // longest-common-subsequence diff, but enough to surface "yes there are
  // differences, ~N lines" without pulling in a diff library.
  const summary = useMemo(() => {
    const a = sourceQuery.data?.yaml ?? "";
    const b = targetQuery.data?.yaml ?? "";
    if (!a || !b) return null;
    const aLines = new Set(a.split("\n"));
    const bLines = new Set(b.split("\n"));
    let unique = 0;
    for (const l of aLines) if (!bLines.has(l)) unique += 1;
    for (const l of bLines) if (!aLines.has(l)) unique += 1;
    return { unique, identical: unique === 0 };
  }, [sourceQuery.data?.yaml, targetQuery.data?.yaml]);

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-full max-w-5xl flex-col rounded-panel border border-border-default bg-surface shadow-[var(--shadow-popover)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-default px-4 py-3">
          <div className="flex flex-col">
            <span className="text-[13px] font-medium text-text-primary">
              compare · {resource.kind}/{resource.name}
            </span>
            <span className="text-[11px] text-text-muted">
              {resource.namespace}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {summary && (
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                  summary.identical
                    ? "border-success/40 bg-success-soft text-success"
                    : "border-warning/40 bg-warning-soft text-warning",
                )}
              >
                {summary.identical
                  ? "identical"
                  : `${summary.unique} unique line${summary.unique === 1 ? "" : "s"}`}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-text-muted hover:bg-elevated hover:text-text-primary"
              aria-label="cancel"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 border-b border-border-subtle px-4 py-2">
          <span className="text-[11px] text-text-muted">target context</span>
          <select
            value={targetCtx}
            onChange={(e) => setTargetCtx(e.target.value)}
            className="term-input h-7 px-2 text-[11px]"
          >
            {otherContexts.length === 0 ? (
              <option value="">no other contexts available</option>
            ) : (
              otherContexts.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                  {c.is_prod ? " (prod)" : ""}
                </option>
              ))
            )}
          </select>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border-subtle">
          <YamlPane label={sourceCtx} query={sourceQuery} />
          <YamlPane label={targetCtx || "—"} query={targetQuery} />
        </div>
      </div>
    </div>
  );
}

function YamlPane({
  label,
  query,
}: {
  label: string;
  query: { data?: { yaml: string }; isLoading: boolean; error: unknown };
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="shrink-0 border-b border-border-subtle px-3 py-1.5 font-mono text-[11px] text-text-muted truncate">
        {label}
      </div>
      <div className="flex-1 overflow-auto bg-code-surface p-3 font-mono text-[11px] leading-relaxed text-text-primary">
        {query.isLoading ? (
          <span className="text-text-muted">loading…</span>
        ) : query.error ? (
          <span className="text-danger">
            {(query.error as Error).message ?? "failed to fetch"}
          </span>
        ) : !query.data ? (
          <span className="text-text-muted">not found in this context</span>
        ) : (
          <pre className="whitespace-pre-wrap break-words">
            {query.data.yaml}
          </pre>
        )}
      </div>
    </div>
  );
}
