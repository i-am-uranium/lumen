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
const NAMESPACE_NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

export function isValidNamespaceName(value: string): boolean {
  return value.length > 0 && value.length <= 63 && NAMESPACE_NAME.test(value);
}

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
  const [input, setInput] = useState("");
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
  const choices = Array.from(
    new Set(value ? [...namespaces, value] : namespaces),
  ).sort();
  const manualNamespace = input.trim();
  const canSelectManual =
    isValidNamespaceName(manualNamespace) && !choices.includes(manualNamespace);
  const invalidManualNamespace =
    manualNamespace.length > 0 && !isValidNamespaceName(manualNamespace);

  function close() {
    setOpen(false);
    setInput("");
  }

  return (
    <div className={cn("relative", className)} ref={ref}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`namespace: ${label}`}
        onClick={() => {
          setOpen((o) => !o);
          setInput("");
        }}
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
            <CommandInput
              value={input}
              onValueChange={setInput}
              placeholder="filter or enter namespace..."
              className="text-xs"
            />
            <CommandList>
              <CommandEmpty>no discovered namespaces match</CommandEmpty>
              <CommandGroup>
                <Item
                  label={ALL_LABEL}
                  active={value === ""}
                  onSelect={() => {
                    onChange("");
                    close();
                  }}
                />
                {choices.map((ns) => (
                  <Item
                    key={ns}
                    label={ns}
                    active={value === ns}
                    onSelect={() => {
                      onChange(ns);
                      close();
                    }}
                  />
                ))}
              </CommandGroup>
            </CommandList>
            {(canSelectManual || invalidManualNamespace) && (
              <div className="border-t border-border-default p-2">
                {canSelectManual ? (
                  <button
                    type="button"
                    aria-label={`use namespace ${manualNamespace}`}
                    onClick={() => {
                      onChange(manualNamespace);
                      close();
                    }}
                    className="w-full rounded-control px-2 py-1.5 text-left text-xs text-text-primary transition hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
                  >
                    use namespace <span className="font-mono">{manualNamespace}</span>
                  </button>
                ) : (
                  <p className="px-2 py-1 text-xs text-danger" role="alert">
                    Enter a valid Kubernetes namespace name.
                  </p>
                )}
              </div>
            )}
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
