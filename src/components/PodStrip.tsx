import { cn } from "@/lib/utils";

type Props = {
  pods: string[];
  colorByPod: Record<string, string>;
  mutedPods: Set<string>;
  onToggleMute: (pod: string) => void;
};

export function PodStrip({ pods, colorByPod, mutedPods, onToggleMute }: Props) {
  return (
    <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-term-border-soft bg-term-panel">
      {pods.map((p) => {
        const muted = mutedPods.has(p);
        return (
          <button
            key={p}
            onClick={() => onToggleMute(p)}
            className={cn(
              "px-2 h-6 text-[11px] font-mono border rounded-sm inline-flex items-center gap-1.5",
              "border-term-border-soft hover:bg-term-panel-2",
              muted && "opacity-40"
            )}
          >
            <span
              className={cn(
                "inline-block size-1.5 rounded-full",
                colorByPod[p] ?? "bg-term-subtle"
              )}
            />
            <span className="text-term-fg">{p}</span>
          </button>
        );
      })}
    </div>
  );
}
