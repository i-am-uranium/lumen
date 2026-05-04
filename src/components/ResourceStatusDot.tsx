import type { Health } from "@/lib/k8s";
import { cn } from "@/lib/utils";

const colorByHealth: Record<Health, string> = {
  healthy: "bg-term-green shadow-[0_0_4px_rgba(91,214,126,0.5)]",
  degraded: "bg-term-amber shadow-[0_0_4px_rgba(232,178,74,0.5)]",
  failed: "bg-term-red shadow-[0_0_4px_rgba(230,106,90,0.5)]",
  unknown: "bg-term-subtle",
};

export function ResourceStatusDot({ health }: { health: Health }) {
  return (
    <span
      className={cn("inline-block size-1.5 rounded-full", colorByHealth[health])}
      aria-label={health}
    />
  );
}
