import { Box } from "lucide-react";
import { cn } from "@/lib/utils";

export function ResourceName({
  name,
  kind,
  className,
}: {
  name: string;
  kind?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <Box className="size-4 shrink-0 text-accent-primary" aria-hidden="true" />
      <div className="min-w-0">
        <div className="truncate font-mono text-sm font-medium text-text-primary" title={name}>
          {name}
        </div>
        {kind && <div className="text-xs text-text-muted">{kind}</div>}
      </div>
    </div>
  );
}
