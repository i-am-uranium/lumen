import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Columns3 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  applyColumnLayout,
  type ColumnView,
  useUiSettings,
} from "@/state/uiSettings";

type PickerColumn = { key: string; label: string; alwaysOn?: boolean };

/**
 * Tiny popover to toggle column visibility AND reorder columns for one
 * of the persisted tabular views. Stays close to the existing Lumen
 * aesthetic — small icon trigger, terse labels, no animation.
 *
 * The "always-on" flag on a column descriptor is honored: those entries
 * render but are disabled from both hide and reorder, so the user
 * understands which columns are pinned (typically `name` — the row
 * anchor). Reorder uses up/down arrow buttons rather than drag-and-drop
 * to stay zero-dependency and accessible by default.
 */
export function ColumnPicker({
  view,
  columns,
}: {
  view: ColumnView;
  columns: PickerColumn[];
}) {
  const hidden = useUiSettings((s) => s.hiddenColumns[view]);
  const order = useUiSettings((s) => s.columnOrder[view]);
  const toggleColumn = useUiSettings((s) => s.toggleColumn);
  const resetColumns = useUiSettings((s) => s.resetColumns);
  const moveColumn = useUiSettings((s) => s.moveColumn);
  const resetColumnOrder = useUiSettings((s) => s.resetColumnOrder);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click / escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const allKeys = useMemo(() => columns.map((c) => c.key), [columns]);

  // Render rows in the same effective order the table will use, so the
  // up/down buttons map intuitively to what the user sees in the table.
  // Hidden columns still appear here (greyed out) so they can be
  // re-shown — that's the picker's whole reason for existing.
  const displayed = useMemo(
    () => applyColumnLayout(columns, order, []),
    [columns, order],
  );

  // Within `displayed`, alwaysOn columns are pinned to the head. The
  // first index a non-alwaysOn column can occupy is therefore right
  // after the last alwaysOn entry — that's the up-button boundary.
  const firstMovableIdx = displayed.findIndex((c) => !c.alwaysOn);
  const lastIdx = displayed.length - 1;

  const hiddenCount = hidden.length;
  const orderCount = order.length;
  const customized = hiddenCount > 0 || orderCount > 0;

  function move(idx: number, delta: 1 | -1) {
    const from = displayed[idx];
    const to = displayed[idx + delta];
    if (!from || !to) return;
    if (from.alwaysOn || to.alwaysOn) return;
    moveColumn(view, from.key, to.key, allKeys);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={
          customized
            ? `Columns · ${hiddenCount} hidden${orderCount > 0 ? " · reordered" : ""}`
            : "Show / hide / reorder columns"
        }
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded border border-border-default bg-surface px-2 text-[11px] text-text-secondary hover:bg-hover",
          customized && "border-accent-primary/40 text-accent-primary",
        )}
      >
        <Columns3 className="size-3.5" aria-hidden="true" />
        <span>columns</span>
        {hiddenCount > 0 && (
          <span className="rounded bg-accent-primary-soft px-1 font-mono text-[10px] tabular-nums">
            {hiddenCount}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-64 rounded-panel border border-border-default bg-surface shadow-[var(--shadow-popover)]"
        >
          <ul className="max-h-72 overflow-auto py-1">
            {displayed.map((c, idx) => {
              const isHidden = hidden.includes(c.key);
              const visible = !isHidden;
              // Up disabled when this row sits at the first movable
              // slot (right after the alwaysOn anchors) OR is alwaysOn
              // itself; symmetric down rule covers the bottom edge.
              const upDisabled =
                c.alwaysOn || idx <= firstMovableIdx || firstMovableIdx === -1;
              const downDisabled =
                c.alwaysOn || idx >= lastIdx || firstMovableIdx === -1;
              return (
                <li
                  key={c.key}
                  className={cn(
                    "flex items-center gap-1 px-2 py-0.5 text-[12px]",
                    !c.alwaysOn && "hover:bg-hover",
                  )}
                >
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={visible}
                    disabled={c.alwaysOn}
                    onClick={() => toggleColumn(view, c.key)}
                    className={cn(
                      "flex flex-1 items-center gap-2 rounded px-1 py-1 text-left",
                      visible ? "text-text-primary" : "text-text-muted",
                      c.alwaysOn && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex size-3.5 shrink-0 items-center justify-center rounded border",
                        visible
                          ? "border-accent-primary bg-accent-primary text-[var(--term-btn-primary-fg)]"
                          : "border-border-default bg-surface",
                      )}
                      aria-hidden="true"
                    >
                      {visible && <Check className="size-2.5" />}
                    </span>
                    <span className="flex-1 truncate">{c.label}</span>
                    {c.alwaysOn && (
                      <span className="text-[10px] uppercase tracking-wide text-text-muted">
                        always
                      </span>
                    )}
                  </button>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => move(idx, -1)}
                      disabled={upDisabled}
                      aria-label={`move ${c.label} up`}
                      title={upDisabled ? undefined : `move ${c.label} up`}
                      className={cn(
                        "inline-flex size-5 items-center justify-center rounded text-text-muted",
                        upDisabled
                          ? "cursor-not-allowed opacity-30"
                          : "hover:bg-elevated hover:text-text-primary",
                      )}
                    >
                      <ChevronUp className="size-3" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(idx, 1)}
                      disabled={downDisabled}
                      aria-label={`move ${c.label} down`}
                      title={downDisabled ? undefined : `move ${c.label} down`}
                      className={cn(
                        "inline-flex size-5 items-center justify-center rounded text-text-muted",
                        downDisabled
                          ? "cursor-not-allowed opacity-30"
                          : "hover:bg-elevated hover:text-text-primary",
                      )}
                    >
                      <ChevronDown className="size-3" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-col gap-0.5 border-t border-border-subtle px-3 py-1.5">
            <button
              type="button"
              onClick={() => {
                resetColumns(view);
                setOpen(false);
              }}
              className="w-full text-left text-[11px] text-text-muted hover:text-text-primary"
            >
              show all columns
            </button>
            <button
              type="button"
              onClick={() => {
                resetColumnOrder(view);
                setOpen(false);
              }}
              disabled={orderCount === 0}
              className={cn(
                "w-full text-left text-[11px]",
                orderCount === 0
                  ? "cursor-not-allowed text-text-muted/50"
                  : "text-text-muted hover:text-text-primary",
              )}
            >
              reset to default order
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
