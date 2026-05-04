import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Props = {
  pods: string[];
  colorByPod: Record<string, string>;
  mutedPods: Set<string>;
  onToggleMute: (pod: string) => void;
};

export function PodStrip({ pods, colorByPod, mutedPods, onToggleMute }: Props) {
  return (
    <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-border-default bg-surface">
      {pods.map((p) => {
        const muted = mutedPods.has(p);
        return (
          <Button
            key={p}
            type="button"
            onClick={() => onToggleMute(p)}
            variant="outline"
            size="sm"
            className={cn(
              "px-2 h-6 text-[11px] font-mono rounded-sm inline-flex items-center gap-1.5",
              "border-border-default hover:bg-hover",
              muted && "opacity-40"
            )}
          >
            <span
              className={cn(
                "inline-block size-1.5 rounded-full",
                colorByPod[p] ?? "bg-text-muted"
              )}
            />
            <span className="text-text-primary">{p}</span>
          </Button>
        );
      })}
    </div>
  );
}
