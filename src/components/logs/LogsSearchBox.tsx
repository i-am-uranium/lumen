import { ChevronUp, ChevronDown, Regex, CaseSensitive } from "lucide-react";
import { cn } from "@/lib/utils";

export type SearchState = {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
};

export function LogsSearchBox({
  query,
  regex,
  caseSensitive,
  matchCount,
  currentMatch,
  regexError,
  onChange,
  onPrev,
  onNext,
}: {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  matchCount: number;
  currentMatch: number; // 0-based; rendered as currentMatch+1
  regexError: string | null;
  onChange: (s: SearchState) => void;
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
      onChange({ query: "", regex, caseSensitive });
    }
  }

  return (
    <div className="flex items-center gap-1.5 flex-1 min-w-0">
      <input
        type="text"
        value={query}
        placeholder="search…"
        onChange={(e) => onChange({ query: e.target.value, regex, caseSensitive })}
        onKeyDown={handleKey}
        className={cn(
          "flex-1 min-w-0 bg-term-panel border rounded text-[11px] text-term-fg px-2 py-1 outline-none placeholder:text-term-subtle",
          regexError ? "border-term-red focus:border-term-red" : "border-term-border-soft focus:border-term-green",
        )}
        title={regexError ?? undefined}
      />
      {query !== "" && (
        <span className="shrink-0 text-[10px] text-term-subtle tabular-nums">
          {matchCount === 0 ? "0/0" : `${currentMatch + 1}/${matchCount}`}
        </span>
      )}
      <button
        type="button"
        onClick={onPrev}
        disabled={matchCount === 0}
        className="shrink-0 p-1 text-term-muted hover:text-term-fg disabled:opacity-30"
        title="previous match (Shift+Enter)"
      >
        <ChevronUp className="size-3" />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        className="shrink-0 p-1 text-term-muted hover:text-term-fg disabled:opacity-30"
        title="next match (Enter)"
      >
        <ChevronDown className="size-3" />
      </button>
      <button
        type="button"
        onClick={() => onChange({ query, regex: !regex, caseSensitive })}
        className={cn(
          "shrink-0 p-1 rounded text-[10px]",
          regex ? "bg-term-green/20 text-term-green" : "text-term-muted hover:text-term-fg",
        )}
        title="regex"
      >
        <Regex className="size-3" />
      </button>
      <button
        type="button"
        onClick={() => onChange({ query, regex, caseSensitive: !caseSensitive })}
        className={cn(
          "shrink-0 p-1 rounded text-[10px]",
          caseSensitive ? "bg-term-green/20 text-term-green" : "text-term-muted hover:text-term-fg",
        )}
        title="case-sensitive"
      >
        <CaseSensitive className="size-3" />
      </button>
    </div>
  );
}
