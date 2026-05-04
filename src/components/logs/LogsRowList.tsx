import { useEffect, useRef, useState } from "react";
import { LogLineRow } from "@/components/LogLineRow";
import type { LogLine } from "@/state/logs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const STICKY_TOLERANCE = 24;

export function LogsRowList({
  lines,
  search,
  podColors,
  showGutter,
}: {
  lines: LogLine[];
  search: string;
  /** Map pod name → CSS class for color dot. Pass empty {} to omit. */
  podColors: Record<string, string>;
  /** Render the 3px pod-color gutter on rows. Use only in split view. */
  showGutter: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);
  const [newLinesPill, setNewLinesPill] = useState(0);
  const lastSeenLengthRef = useRef(lines.length);

  useEffect(() => {
    if (stickyRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      lastSeenLengthRef.current = lines.length;
      setNewLinesPill(0);
    } else {
      setNewLinesPill(lines.length - lastSeenLengthRef.current);
    }
  }, [lines.length]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = dist < STICKY_TOLERANCE;
    stickyRef.current = atBottom;
    if (atBottom) {
      lastSeenLengthRef.current = lines.length;
      setNewLinesPill(0);
    }
  }

  function jumpToLive() {
    stickyRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    lastSeenLengthRef.current = lines.length;
    setNewLinesPill(0);
  }

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto bg-surface"
      >
        {lines.length === 0 && (
          <div className="px-3 py-6 text-[12px] text-text-muted">
            no logs yet · streaming
          </div>
        )}
        {lines.map((line) => (
          <div key={`${line.pod}|${line.container}|${line.id}`} className="flex">
            {showGutter && (
              <div className={cn("w-[3px] shrink-0", podColors[line.pod] ?? "bg-transparent")} />
            )}
            <div className="flex-1 min-w-0">
              <LogLineRow
                line={line}
                color={podColors[line.pod] ?? "text-text-secondary"}
                highlight={search}
              />
            </div>
          </div>
        ))}
      </div>
      {newLinesPill > 0 && (
        <Button
          type="button"
          onClick={jumpToLive}
          variant="outline"
          size="sm"
          className="absolute bottom-3 right-3 h-7 rounded-full px-3 text-[11px] bg-accent-primary-soft text-accent-primary border-accent-primary/40 shadow-[var(--shadow-popover)] hover:bg-accent-primary-soft/80"
        >
          Live +{newLinesPill} {newLinesPill === 1 ? "line" : "lines"}
        </Button>
      )}
    </div>
  );
}
