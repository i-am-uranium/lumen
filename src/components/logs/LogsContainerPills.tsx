import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type ContainerKind = "regular" | "init";

export type ContainerOption = {
  name: string;
  kind: ContainerKind;
};

export function LogsContainerPills({
  options,
  selection,
  onChange,
}: {
  options: ContainerOption[];
  /** "all" or a list of selected container names. */
  selection: "all" | string[];
  onChange: (next: "all" | string[]) => void;
}) {
  const isAll = selection === "all";
  const selSet = new Set(isAll ? [] : selection);

  function toggle(name: string) {
    if (isAll) {
      onChange([name]);
      return;
    }
    const next = new Set(selSet);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    if (next.size === 0 || next.size === options.length) {
      onChange("all");
    } else {
      onChange(Array.from(next));
    }
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <Button
        type="button"
        onClick={() => onChange("all")}
        variant="outline"
        size="sm"
        className={cn(
          "h-6 px-2 rounded text-[10px] tabular-nums",
          isAll
            ? "bg-accent-primary-soft text-accent-primary border-accent-primary/40"
            : "text-text-secondary",
        )}
      >
        all
      </Button>
      {options.map((c) => {
        const active = isAll || selSet.has(c.name);
        return (
          <Button
            key={c.name}
            type="button"
            onClick={() => toggle(c.name)}
            variant="outline"
            size="sm"
            className={cn(
              "h-6 px-2 rounded text-[10px] tabular-nums",
              active
                ? "bg-surface text-text-primary border-border-default"
                : "border-border-default/60 text-text-muted hover:text-text-primary",
              c.kind === "init" && "italic opacity-70",
            )}
            title={c.kind === "init" ? `init container: ${c.name}` : c.name}
          >
            {c.name}
          </Button>
        );
      })}
    </div>
  );
}
