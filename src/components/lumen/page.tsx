import * as React from "react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

export function LumenPage({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="h-full overflow-auto bg-app">
      <div className="lumen-page">
        <div
          className={cn(
            "mx-auto flex w-full max-w-[1680px] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8",
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  icon,
  actions,
  className,
}: {
  eyebrow: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("bg-shell/90 p-4", className)}>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-accent-primary">
            {icon && <span className="shrink-0">{icon}</span>}
            {eyebrow}
          </div>
          <h1 className="mt-2 text-2xl font-semibold leading-tight text-text-primary">{title}</h1>
          {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-col gap-3 lg:items-end">{actions}</div>}
      </div>
    </Card>
  );
}

export function SectionPanel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <Card className={cn("bg-shell/80 p-4", className)}>{children}</Card>;
}

export function PanelHeading({
  eyebrow,
  title,
  meta,
  icon,
}: {
  eyebrow?: React.ReactNode;
  title?: React.ReactNode;
  meta?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow && (
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            {icon && <span className="shrink-0">{icon}</span>}
            {eyebrow}
          </div>
        )}
        {title && <h2 className="mt-1 text-base font-semibold text-text-primary">{title}</h2>}
      </div>
      {meta && <div className="text-xs text-text-muted">{meta}</div>}
    </div>
  );
}

export function ToolbarSurface({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-control border border-border-default bg-shell/70 p-1", className)}>
      {children}
    </div>
  );
}
