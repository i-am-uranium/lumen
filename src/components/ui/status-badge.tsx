import { cn } from "@/lib/utils";

type StatusTone = "success" | "warning" | "error" | "info" | "unknown";

function statusTone(status: string): StatusTone {
  const normalized = status.toLowerCase();
  if (["healthy", "ready", "running", "succeeded", "connected", "active"].includes(normalized)) {
    return "success";
  }
  if (["degraded", "warning", "pending", "firing", "restarting"].includes(normalized)) {
    return "warning";
  }
  if (["error", "failed", "unhealthy", "unreachable", "crashloopbackoff", "critical"].includes(normalized)) {
    return "error";
  }
  if (["info", "unknown", "completed"].includes(normalized)) {
    return "info";
  }
  return "unknown";
}

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const tone = statusTone(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize",
        tone === "success" && "border-success/25 bg-[var(--status-success-soft)] text-success",
        tone === "warning" && "border-warning/25 bg-[var(--status-warning-soft)] text-warning",
        tone === "error" && "border-danger/30 bg-[var(--status-error-soft)] text-danger",
        tone === "info" && "border-info/25 bg-[var(--status-info-soft)] text-info",
        tone === "unknown" && "border-border-strong bg-elevated text-text-muted",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {status}
    </span>
  );
}
