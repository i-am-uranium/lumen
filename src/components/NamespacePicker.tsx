import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

const ALL_LABEL = "all namespaces";

export function NamespacePicker({
  value,
  namespaces,
  onChange,
  className,
}: {
  value: string;
  namespaces: string[];
  onChange: (next: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const label = value || ALL_LABEL;

  return (
    <div className={cn("relative", className)} ref={ref}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex h-9 w-[200px] items-center justify-between gap-2 rounded-control border border-border-default bg-elevated px-3 py-2 text-xs text-text-primary outline-none transition hover:bg-hover focus-visible:ring-2 focus-visible:ring-primary/45",
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-[260px] overflow-hidden rounded-control border border-border-default bg-surface shadow-[var(--shadow-popover)]">
          <Command shouldFilter className="bg-surface">
            <CommandInput placeholder="filter namespaces..." className="text-xs" />
            <CommandList>
              <CommandEmpty>no namespaces match</CommandEmpty>
              <CommandGroup>
                <Item
                  label={ALL_LABEL}
                  active={value === ""}
                  onSelect={() => {
                    onChange("");
                    setOpen(false);
                  }}
                />
                {namespaces.map((ns) => (
                  <Item
                    key={ns}
                    label={ns}
                    active={value === ns}
                    onSelect={() => {
                      onChange(ns);
                      setOpen(false);
                    }}
                  />
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}

function Item({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={label}
      onSelect={onSelect}
      className={cn(
        "text-xs",
        active && "bg-accent-primary-soft text-text-primary",
      )}
    >
      <Check
        className={cn("size-3.5 shrink-0", active ? "opacity-100" : "opacity-0")}
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
    </CommandItem>
  );
}
