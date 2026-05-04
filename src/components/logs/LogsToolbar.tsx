import { Pause, Play, Eraser, WrapText, Clock, Download, ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { LogsContainerPills, type ContainerOption } from "./LogsContainerPills";
import { LogsSearchBox, type SearchState } from "./LogsSearchBox";
import { Button } from "@/components/ui/button";

const RANGE_OPTIONS: { label: string; seconds: number | null }[] = [
  { label: "15m", seconds: 15 * 60 },
  { label: "1h", seconds: 60 * 60 },
  { label: "6h", seconds: 6 * 60 * 60 },
  { label: "24h", seconds: 24 * 60 * 60 },
  { label: "all", seconds: null },
];

const LEVELS = ["error", "warn", "info", "debug"] as const;
export type Level = (typeof LEVELS)[number];

export function LogsToolbar({
  containers, containerSelection, onContainerChange,
  search, matchCount, currentMatch, regexError, onSearchChange, onSearchPrev, onSearchNext,
  levels, onLevelToggle,
  rangeSeconds, onRangeChange,
  paused, onPauseToggle, pendingCount,
  onClear, wrap, onWrapToggle, timestamps, onTimestampsToggle,
  onDownload, downloading,
}: {
  containers: ContainerOption[];
  containerSelection: "all" | string[];
  onContainerChange: (next: "all" | string[]) => void;
  search: SearchState;
  matchCount: number;
  currentMatch: number;
  regexError: string | null;
  onSearchChange: (s: SearchState) => void;
  onSearchPrev: () => void;
  onSearchNext: () => void;
  levels: Set<Level>;
  onLevelToggle: (l: Level) => void;
  rangeSeconds: number | null;
  onRangeChange: (seconds: number | null) => void;
  paused: boolean;
  onPauseToggle: () => void;
  pendingCount: number;
  onClear: () => void;
  wrap: boolean;
  onWrapToggle: () => void;
  timestamps: boolean;
  onTimestampsToggle: () => void;
  onDownload: () => void;
  downloading: boolean;
}) {
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeLabel = RANGE_OPTIONS.find((o) => o.seconds === rangeSeconds)?.label ?? "all";

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border-default bg-elevated">
      <LogsContainerPills options={containers} selection={containerSelection} onChange={onContainerChange} />

      <div className="h-4 w-px bg-border-default mx-1" />

      <LogsSearchBox
        query={search.query}
        regex={search.regex}
        caseSensitive={search.caseSensitive}
        matchCount={matchCount}
        currentMatch={currentMatch}
        regexError={regexError}
        onChange={onSearchChange}
        onPrev={onSearchPrev}
        onNext={onSearchNext}
      />

      <div className="flex items-center gap-1">
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => onLevelToggle(l)}
            className={cn(
              "px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide",
              levels.has(l)
                ? "bg-surface text-text-primary border-border-default"
                : "border-border-default/60 text-text-muted line-through opacity-60",
            )}
          >
            {l}
          </button>
        ))}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setRangeOpen((o) => !o)}
          className="px-2 py-0.5 rounded text-[10px] border border-border-default text-text-secondary hover:text-text-primary flex items-center gap-1"
        >
          {rangeLabel}
          <ChevronDown className="size-2.5" />
        </button>
        {rangeOpen && (
          <div className="absolute right-0 top-full mt-1 z-10 bg-surface border border-border-default rounded-control shadow-[var(--shadow-popover)] py-1 min-w-[80px]">
            {RANGE_OPTIONS.map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => { onRangeChange(o.seconds); setRangeOpen(false); }}
                className={cn(
                  "block w-full text-left px-2 py-1 text-[11px] hover:bg-hover",
                  o.seconds === rangeSeconds ? "text-accent-primary" : "text-text-primary",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-0.5 ml-auto">
        <IconBtn onClick={onPauseToggle} title={paused ? `resume (${pendingCount} buffered)` : "pause"}>
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
        </IconBtn>
        <IconBtn onClick={onClear} title="clear buffer">
          <Eraser className="size-3.5" />
        </IconBtn>
        <IconBtn onClick={onWrapToggle} title={wrap ? "unwrap" : "wrap"} active={wrap}>
          <WrapText className="size-3.5" />
        </IconBtn>
        <IconBtn onClick={onTimestampsToggle} title="timestamps" active={timestamps}>
          <Clock className="size-3.5" />
        </IconBtn>
        <IconBtn onClick={onDownload} title="download" disabled={downloading}>
          <Download className="size-3.5" />
        </IconBtn>
      </div>
    </div>
  );
}

function IconBtn({
  children, onClick, title, active, disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      variant="ghost"
      size="icon"
      className={cn(
        "size-7 rounded",
        active && "bg-accent-primary-soft text-accent-primary",
        disabled && "opacity-40 cursor-not-allowed",
      )}
    >
      {children}
    </Button>
  );
}
