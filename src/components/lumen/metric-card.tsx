import * as React from "react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

export type MetricTone = "neutral" | "success" | "warning" | "error" | "info" | "muted";

export function toneTextClass(tone: MetricTone): string {
  return {
    neutral: "text-text-secondary",
    success: "text-success",
    warning: "text-warning",
    error: "text-danger",
    info: "text-accent-primary",
    muted: "text-text-muted",
  }[tone];
}

function MiniTrend({ tone = "info" }: { tone?: Exclude<MetricTone, "neutral" | "muted"> }) {
  const stroke = {
    success: "var(--status-success)",
    warning: "var(--status-warning)",
    error: "var(--status-error)",
    info: "var(--accent-primary)",
  }[tone];
  return (
    <svg viewBox="0 0 84 28" className="h-7 w-20 shrink-0" aria-hidden="true">
      <path
        d="M2 21 C 13 20, 13 11, 25 13 S 42 23, 52 14 S 68 5, 82 8"
        fill="none"
        stroke={stroke}
        strokeLinecap="round"
        strokeWidth="2"
      />
      <path
        d="M2 21 C 13 20, 13 11, 25 13 S 42 23, 52 14 S 68 5, 82 8 L82 28 L2 28 Z"
        fill={stroke}
        opacity="0.1"
      />
    </svg>
  );
}

export function MetricCard({
  icon,
  label,
  value,
  helper,
  tone = "neutral",
  trend = false,
  className,
  onClick,
  active = false,
  actionLabel,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  value: React.ReactNode;
  helper?: React.ReactNode;
  tone?: MetricTone;
  trend?: boolean;
  className?: string;
  onClick?: () => void;
  active?: boolean;
  actionLabel?: string;
}) {
  const trendTone = tone === "success" || tone === "warning" || tone === "error" ? tone : "info";
  const interactive = typeof onClick === "function";
  const body = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
          {icon && <span className={cn("shrink-0", toneTextClass(tone))}>{icon}</span>}
          <span className="truncate">{label}</span>
        </div>
        <div className="mt-3 text-2xl font-semibold leading-none text-text-primary tabular-nums">
          {value}
        </div>
        {helper && (
          <div
            className={cn(
              "mt-2 text-xs tabular-nums",
              toneTextClass(tone),
              interactive && "underline decoration-dotted underline-offset-2",
            )}
          >
            {helper}
          </div>
        )}
      </div>
      {trend && <MiniTrend tone={trendTone} />}
    </div>
  );
  const cardCls = cn(
    "bg-surface/95 p-4 shadow-none",
    interactive &&
      "cursor-pointer transition-colors hover:border-accent-primary/40 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50",
    active && "border-accent-primary/60 bg-accent-primary-soft/30",
    className,
  );
  if (interactive) {
    return (
      <Card
        className={cardCls}
        role="button"
        tabIndex={0}
        aria-pressed={active}
        aria-label={actionLabel}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick?.();
          }
        }}
      >
        {body}
      </Card>
    );
  }
  return <Card className={cardCls}>{body}</Card>;
}
