import { ChevronUp, ChevronDown, CaseSensitive } from "lucide-react";
import { cn } from "@/lib/utils";

export type ShellSearchState = { query: string; caseSensitive: boolean };

export function ShellSearchBox({
  query, caseSensitive, matchCount, currentMatch,
  onChange, onPrev, onNext,
}: {
  query: string;
  caseSensitive: boolean;
  matchCount: number;
  currentMatch: number;
  onChange: (s: ShellSearchState) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onChange({ query: "", caseSensitive });
    }
  }
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <input
        type="text"
        value={query}
        placeholder="search…"
        onChange={(e) => onChange({ query: e.target.value, caseSensitive })}
        onKeyDown={handleKey}
        className="w-[160px] bg-term-panel border border-term-border-soft rounded text-[11px] text-term-fg px-2 py-1 outline-none focus:border-term-green placeholder:text-term-subtle"
      />
      {query !== "" && (
        <span className="shrink-0 text-[10px] text-term-subtle tabular-nums">
          {matchCount === 0 ? "0/0" : `${currentMatch + 1}/${matchCount}`}
        </span>
      )}
      <button type="button" onClick={onPrev} disabled={matchCount === 0}
        className="shrink-0 p-1 text-term-muted hover:text-term-fg disabled:opacity-30"
        title="previous match (Shift+Enter)">
        <ChevronUp className="size-3" />
      </button>
      <button type="button" onClick={onNext} disabled={matchCount === 0}
        className="shrink-0 p-1 text-term-muted hover:text-term-fg disabled:opacity-30"
        title="next match (Enter)">
        <ChevronDown className="size-3" />
      </button>
      <button type="button"
        onClick={() => onChange({ query, caseSensitive: !caseSensitive })}
        className={cn(
          "shrink-0 p-1 rounded text-[10px]",
          caseSensitive ? "bg-term-green/20 text-term-green" : "text-term-muted hover:text-term-fg",
        )}
        title="case-sensitive">
        <CaseSensitive className="size-3" />
      </button>
    </div>
  );
}
