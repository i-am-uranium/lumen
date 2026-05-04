import { Star } from "lucide-react";
import { usePinnedResources, type PinnedRef } from "@/hooks/usePinnedResources";
import { cn } from "@/lib/utils";

type Props = {
  ctx: string;
  resource: PinnedRef;
  className?: string;
};

/**
 * Star toggle for pinning/unpinning a resource within a cluster context.
 * Renders a filled amber star when pinned, a hollow muted star otherwise.
 */
export function PinButton({ ctx, resource, className }: Props) {
  const { isPinned, toggle } = usePinnedResources(ctx);
  const pinned = isPinned(resource);
  const label = pinned
    ? `Unpin ${resource.kind}/${resource.name}`
    : `Pin ${resource.kind}/${resource.name}`;

  return (
    <button
      type="button"
      onClick={() => toggle(resource)}
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      className={cn(
        "inline-flex items-center justify-center size-6 rounded-md border border-transparent transition-colors",
        "hover:bg-term-panel-2",
        pinned ? "text-term-amber" : "text-term-subtle hover:text-term-fg",
        className,
      )}
    >
      <Star
        className={cn("size-3.5", pinned && "fill-current")}
        aria-hidden="true"
      />
    </button>
  );
}
