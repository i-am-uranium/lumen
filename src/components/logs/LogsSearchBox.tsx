import { ChevronUp, ChevronDown, Regex, CaseSensitive } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
      <Input
        type="text"
        value={query}
        placeholder="search..."
        onChange={(e) => onChange({ query: e.target.value, regex, caseSensitive })}
        onKeyDown={handleKey}
        className={cn(
          "h-8 flex-1 min-w-0 rounded-control text-[11px]",
          regexError && "border-danger focus-visible:ring-danger/45",
        )}
        title={regexError ?? undefined}
      />
      {query !== "" && (
        <span className="shrink-0 text-[10px] text-text-muted tabular-nums">
          {matchCount === 0 ? "0/0" : `${currentMatch + 1}/${matchCount}`}
        </span>
      )}
      <Button
        type="button"
        onClick={onPrev}
        disabled={matchCount === 0}
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        title="previous match (Shift+Enter)"
      >
        <ChevronUp className="size-3" />
      </Button>
      <Button
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        title="next match (Enter)"
      >
        <ChevronDown className="size-3" />
      </Button>
      <Button
        type="button"
        onClick={() => onChange({ query, regex: !regex, caseSensitive })}
        variant="ghost"
        size="icon"
        className={cn(
          "size-7 shrink-0",
          regex && "bg-accent-primary-soft text-accent-primary",
        )}
        title="regex"
      >
        <Regex className="size-3" />
      </Button>
      <Button
        type="button"
        onClick={() => onChange({ query, regex, caseSensitive: !caseSensitive })}
        variant="ghost"
        size="icon"
        className={cn(
          "size-7 shrink-0",
          caseSensitive && "bg-accent-primary-soft text-accent-primary",
        )}
        title="case-sensitive"
      >
        <CaseSensitive className="size-3" />
      </Button>
    </div>
  );
}
