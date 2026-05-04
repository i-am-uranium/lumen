import { cn } from "@/lib/utils";

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
      <button
        type="button"
        onClick={() => onChange("all")}
        className={cn(
          "px-2 py-0.5 rounded text-[10px] border tabular-nums",
          isAll
            ? "bg-term-green/20 text-term-green border-term-green/40"
            : "border-term-border-soft text-term-muted hover:text-term-fg",
        )}
      >
        all
      </button>
      {options.map((c) => {
        const active = isAll || selSet.has(c.name);
        return (
          <button
            key={c.name}
            type="button"
            onClick={() => toggle(c.name)}
            className={cn(
              "px-2 py-0.5 rounded text-[10px] border tabular-nums",
              active
                ? "bg-term-panel-2 text-term-fg border-term-border-soft"
                : "border-term-border-soft/50 text-term-subtle hover:text-term-fg",
              c.kind === "init" && "italic opacity-70",
            )}
            title={c.kind === "init" ? `init container: ${c.name}` : c.name}
          >
            {c.name}
          </button>
        );
      })}
    </div>
  );
}
