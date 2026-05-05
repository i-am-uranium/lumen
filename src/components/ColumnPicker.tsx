import { useEffect, useRef, useState } from "react";
import { Columns3, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { type ColumnView, useUiSettings } from "@/state/uiSettings";

/**
 * Tiny popover to toggle column visibility for one of the persisted
 * tabular views. Stays close to the existing Lumen aesthetic — small
 * icon trigger, terse labels, no animation. The "always-on" flag on a
 * column descriptor is honored: those entries render but are disabled,
 * so the user understands which columns can't be hidden (typically
 * `name` — without it, rows have no anchor).
 */
export function ColumnPicker({
  view,
  columns,
}: {
  view: ColumnView;
  columns: Array<{ key: string; label: string; alwaysOn?: boolean }>;
}) {
  const hidden = useUiSettings((s) => s.hiddenColumns[view]);
  const toggleColumn = useUiSettings((s) => s.toggleColumn);
  const resetColumns = useUiSettings((s) => s.resetColumns);
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

  const hiddenCount = hidden.length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={
          hiddenCount > 0
            ? `Columns · ${hiddenCount} hidden`
            : "Show / hide columns"
        }
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded border border-border-default bg-surface px-2 text-[11px] text-text-secondary hover:bg-hover",
          hiddenCount > 0 && "border-accent-primary/40 text-accent-primary",
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
          className="absolute right-0 z-30 mt-1 w-56 rounded-panel border border-border-default bg-surface shadow-[var(--shadow-popover)]"
        >
          <ul className="max-h-72 overflow-auto py-1">
            {columns.map((c) => {
              const isHidden = hidden.includes(c.key);
              const visible = !isHidden;
              return (
                <li key={c.key}>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={visible}
                    disabled={c.alwaysOn}
                    onClick={() => toggleColumn(view, c.key)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]",
                      visible ? "text-text-primary" : "text-text-muted",
                      c.alwaysOn
                        ? "cursor-not-allowed opacity-60"
                        : "hover:bg-hover",
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
                </li>
              );
            })}
          </ul>
          <div className="border-t border-border-subtle px-3 py-1.5">
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
          </div>
        </div>
      )}
    </div>
  );
}
