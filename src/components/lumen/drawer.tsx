import * as React from "react";
import { cn } from "@/lib/utils";

export function DrawerBackdrop({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("fixed inset-0 z-40 bg-black/30 transition-opacity duration-150", className)}
      {...props}
    />
  );
}

export function DrawerPanel({
  width,
  className,
  style,
  ...props
}: React.HTMLAttributes<HTMLElement> & { width?: number }) {
  return (
    <aside
      className={cn(
        "fixed right-0 top-0 z-50 flex h-full max-w-[100vw] flex-col border-l border-border-default bg-shell shadow-[var(--shadow-popover)]",
        "transition-transform duration-200 ease-out",
        className,
      )}
      style={{ width, ...style }}
      {...props}
    />
  );
}

export function DrawerResizeHandle({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("group absolute bottom-0 left-0 top-0 z-10 w-1 cursor-col-resize", className)}
      title="drag to resize"
      {...props}
    >
      <div className="absolute inset-y-0 left-0 w-px bg-transparent transition-colors group-hover:bg-accent-primary" />
    </div>
  );
}

export function DrawerHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-h-14 shrink-0 items-center gap-2 border-b border-border-default bg-shell px-3 py-2",
        className,
      )}
      {...props}
    />
  );
}

export function DrawerTabs({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-0 border-b border-border-default bg-elevated px-2",
        className,
      )}
      {...props}
    />
  );
}

export function DrawerTabButton({
  active,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "h-9 border-b-2 px-3 text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
        active
          ? "border-accent-primary text-text-primary"
          : "border-transparent text-text-secondary hover:text-text-primary",
        "disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-text-secondary",
        className,
      )}
      {...props}
    />
  );
}
