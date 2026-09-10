import { useMemo } from "react";
import { yamlLineDiff, type YamlDiffLine } from "@/lib/yamlLineDiff";
import { cn } from "@/lib/utils";

function Line({
  line,
  changed,
  side,
}: {
  line: YamlDiffLine | null;
  changed: boolean;
  side: "before" | "after";
}) {
  const mark = changed && line ? (side === "before" ? "−" : "+") : " ";
  return (
    <div
      className={cn(
        "flex min-w-0 font-mono text-[12px] leading-relaxed",
        changed &&
          line &&
          (side === "before"
            ? "bg-term-red/10 text-term-red"
            : "bg-term-green/10 text-term-green"),
      )}
    >
      <span
        className="w-14 shrink-0 select-none pl-2 text-term-subtle @[36rem]:hidden"
        aria-hidden="true"
      >
        {side === "before" ? "original" : "draft"}
      </span>
      <span
        className="w-10 shrink-0 select-none pr-2 text-right text-term-subtle"
        aria-hidden="true"
      >
        {line?.number}
      </span>
      <span className="w-4 shrink-0 select-none" aria-hidden="true">
        {mark}
      </span>
      <span className="sr-only">
        {line
          ? `${side === "before" ? "Original" : "Draft"} line ${line.number}${changed ? (side === "before" ? ", removed" : ", added") : ", unchanged"}: `
          : "No corresponding line"}
      </span>
      <code className="min-w-0 whitespace-pre-wrap break-all">
        {line?.text || "\u00a0"}
      </code>
    </div>
  );
}

/** Aligned on wide panels; each original/draft pair stacks on narrow panels. */
export function YamlDiffView({
  before,
  after,
}: {
  before: string;
  after: string;
}) {
  const diff = useMemo(() => yamlLineDiff(before, after), [before, after]);
  return (
    <section
      aria-label="YAML changes"
      className="@container flex min-h-0 flex-1 flex-col bg-term-bg"
    >
      <div className="shrink-0 border-b border-term-border-soft px-4 py-2 text-[11px] text-term-muted">
        {diff.limited
          ? "Line comparison unavailable for this document size. Return to Edit draft to inspect the full YAML; no changes have been omitted from your draft."
          : diff.additions === 0 && diff.deletions === 0
            ? "No line changes"
            : `${diff.additions} added · ${diff.deletions} removed`}
      </div>
      {!diff.limited && (
        <div
          className="min-h-0 flex-1 overflow-auto"
          tabIndex={0}
          aria-label="Original and draft comparison"
        >
          <div className="sticky top-0 z-10 grid grid-cols-1 border-b border-term-border-soft bg-term-panel text-[11px] font-semibold text-term-muted @[36rem]:grid-cols-2">
            <div className="px-4 py-2">Original · edit-start snapshot</div>
            <div className="px-4 py-2">Draft · unapplied changes</div>
          </div>
          <div className="py-2">
            {diff.rows.map((row, index) => (
              <div
                key={index}
                className="grid grid-cols-1 @[36rem]:grid-cols-2"
              >
                <Line line={row.before} changed={row.changed} side="before" />
                <Line line={row.after} changed={row.changed} side="after" />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
