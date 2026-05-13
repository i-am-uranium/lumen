import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { PaneShell } from "@/components/PaneShell";
import { usePanesStore } from "@/state/panes";

/**
 * Renders all open panes side-by-side with a draggable splitter
 * between each pair. Sizes are tracked in `panesStore.sizes` as
 * percentages and persisted across reloads.
 *
 * Splits are horizontal-only for now (panes laid out left-to-right);
 * the store carries an `orientation` flag so vertical splits can be
 * added later without further store changes.
 */
export function SplitView() {
  const panes = usePanesStore((s) => s.panes);
  const focusedId = usePanesStore((s) => s.focusedId);
  const sizes = usePanesStore((s) => s.sizes);
  const setSizes = usePanesStore((s) => s.setSizes);
  const closePane = usePanesStore((s) => s.closePane);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Sizes can drift out of sync with panes briefly during a store
  // reset; defend against the array-length mismatch so we don't
  // crash on the first render after a reset.
  const effectiveSizes =
    sizes.length === panes.length
      ? sizes
      : panes.map(() => 100 / Math.max(panes.length, 1));

  const onSplitterDrag = useCallback(
    (splitterIndex: number, startEvent: React.MouseEvent) => {
      startEvent.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const containerWidth = container.getBoundingClientRect().width;
      // Snapshot the sizes at drag start so the maths is stable
      // across rapid mousemove events.
      const startSizes = effectiveSizes.slice();
      const startX = startEvent.clientX;

      const onMove = (e: MouseEvent) => {
        const dx = e.clientX - startX;
        const pctDelta = (dx / containerWidth) * 100;
        const next = startSizes.slice();
        // Keep both affected panes ≥ 10% so neither collapses
        // completely — that confused users in early prototypes.
        const min = 10;
        const left = startSizes[splitterIndex] + pctDelta;
        const right = startSizes[splitterIndex + 1] - pctDelta;
        if (left < min || right < min) return;
        next[splitterIndex] = left;
        next[splitterIndex + 1] = right;
        setSizes(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [effectiveSizes, setSizes],
  );

  const multiPane = panes.length > 1;

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 w-full overflow-hidden"
    >
      {panes.flatMap((pane, i) => {
        const cell = (
          <div
            key={pane.id}
            style={{ flexBasis: `${effectiveSizes[i]}%` }}
            className="flex min-w-0 flex-shrink-0 flex-grow-0 flex-col"
          >
            <PaneShell
              paneId={pane.id}
              initialUrl={pane.url}
              focused={pane.id === focusedId}
              showPaneChrome={multiPane}
              onClose={() => closePane(pane.id)}
            />
          </div>
        );
        if (i === panes.length - 1) return [cell];
        const splitter = (
          <Splitter
            key={`splitter-${pane.id}`}
            onMouseDown={(e) => onSplitterDrag(i, e)}
          />
        );
        return [cell, splitter];
      })}
    </div>
  );
}

function Splitter({
  onMouseDown,
}: {
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  // Keyboard resize is intentionally not wired yet — splitters carry
  // focus by default and dragging covers the high-leverage case;
  // arrow-key resize can land alongside vertical splits later.
  useEffect(() => {
    // Reset hover state if the splitter unmounts mid-hover (e.g. when
    // user closes a pane right as they were near the splitter).
    return () => setHover(false);
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cn(
        "h-full w-[5px] shrink-0 cursor-col-resize bg-term-border-soft transition-colors",
        hover && "bg-accent-primary/60",
      )}
    />
  );
}
