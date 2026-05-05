import { useEffect, useRef, useState } from "react";
import { Laptop, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useThemeStore, type ThemeMode } from "@/state/theme";

/**
 * Topbar theme switcher.
 *
 * Shows the *active* mode's icon as a trigger; clicking opens a small
 * popover with all three modes. We surface "system" as a first-class
 * option (rather than just a checkbox somewhere) because it's the right
 * default for most users — explicit control without giving up OS sync.
 *
 * The icon updates as `mode` changes, not `applied`. So if a user picks
 * "system" and OS happens to be light, the icon shows the laptop, not
 * the sun — telling the user "you're in system mode" is more useful
 * than "you're in light mode (because system)".
 */

const OPTIONS: { mode: ThemeMode; label: string; Icon: typeof Sun; hint: string }[] = [
  { mode: "light", label: "Light", Icon: Sun, hint: "Always light" },
  { mode: "dark", label: "Dark", Icon: Moon, hint: "Always dark" },
  { mode: "system", label: "System", Icon: Laptop, hint: "Follow OS preference" },
];

function iconForMode(mode: ThemeMode) {
  return OPTIONS.find((o) => o.mode === mode)!.Icon;
}

export function ThemeSwitcher() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click — same pattern as the LogsTabStrip add menu.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const ActiveIcon = iconForMode(mode);
  const activeLabel = OPTIONS.find((o) => o.mode === mode)!.label;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Theme: ${activeLabel} — click to change`}
        aria-label={`Theme: ${activeLabel} — click to change`}
        className={cn(
          "inline-flex h-8 items-center justify-center rounded-[6px] border border-term-border-soft bg-term-bg/70 px-2 text-term-muted transition-colors",
          "hover:border-accent-primary/35 hover:text-term-fg",
        )}
      >
        <ActiveIcon className="size-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-[180px] overflow-hidden rounded-control border border-border-default bg-surface shadow-[var(--shadow-popover)]"
        >
          {OPTIONS.map(({ mode: optMode, label, Icon, hint }) => {
            const active = optMode === mode;
            return (
              <button
                key={optMode}
                role="menuitemradio"
                aria-checked={active}
                type="button"
                onClick={() => {
                  setMode(optMode);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors",
                  active
                    ? "bg-accent-primary-soft text-accent-primary"
                    : "text-text-primary hover:bg-hover",
                )}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="flex-1">{label}</span>
                <span className="text-[10px] text-text-muted">{hint}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
