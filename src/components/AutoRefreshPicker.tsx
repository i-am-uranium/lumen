import { useEffect, useRef, useState } from "react";
import { ChevronDown, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { WORKLOADS_AUTO_REFRESH_OPTIONS } from "@/state/uiSettings";

/**
 * Dropdown for picking an auto-refresh interval. `null` = off.
 *
 * Designed to sit next to the page's manual refresh button — pressing
 * refresh is still the primary action, the picker is for users who want
 * it to happen on a cadence without thinking about it.
 */
export function AutoRefreshPicker({
  valueSeconds,
  onChange,
  className,
}: {
  valueSeconds: number | null;
  onChange: (next: number | null) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeLabel =
    WORKLOADS_AUTO_REFRESH_OPTIONS.find((o) => o.seconds === valueSeconds)?.label ?? "off";
  const isOn = valueSeconds !== null;

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={isOn ? `auto-refresh every ${activeLabel}` : "auto-refresh: off"}
        className={cn(
          "h-8 gap-1.5 text-[11px]",
          isOn && "border-accent-primary/40 text-accent-primary",
        )}
      >
        <Timer className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">auto:</span> {activeLabel}
        <ChevronDown className="size-3" aria-hidden="true" />
      </Button>
      {open && (
        <ul
          role="listbox"
          aria-label="auto-refresh interval"
          className="absolute right-0 top-full z-20 mt-1 min-w-[100px] rounded-control border border-border-default bg-surface py-1 shadow-[var(--shadow-popover)]"
        >
          {WORKLOADS_AUTO_REFRESH_OPTIONS.map((o) => {
            const selected = o.seconds === valueSeconds;
            return (
              <li key={o.label}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(o.seconds);
                    setOpen(false);
                  }}
                  className={cn(
                    "block w-full px-2 py-1 text-left text-[11px] hover:bg-hover",
                    selected ? "text-accent-primary" : "text-text-primary",
                  )}
                >
                  {o.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
