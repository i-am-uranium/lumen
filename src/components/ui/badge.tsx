import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary/45",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-accent-primary text-white",
        secondary:
          "border-border-default bg-elevated text-text-secondary",
        destructive:
          "border-danger/35 bg-[var(--status-error-soft)] text-danger",
        outline: "border-border-default text-text-primary",
        success: "border-success/25 bg-[var(--status-success-soft)] text-success",
        warning: "border-warning/25 bg-[var(--status-warning-soft)] text-warning",
        info: "border-info/25 bg-[var(--status-info-soft)] text-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
