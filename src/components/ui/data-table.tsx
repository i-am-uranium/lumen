import * as React from "react";
import { cn } from "@/lib/utils";

const DataTableShell = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("overflow-auto rounded-panel border border-border-default bg-surface", className)}
    {...props}
  />
));
DataTableShell.displayName = "DataTableShell";

const DataTable = React.forwardRef<
  HTMLTableElement,
  React.TableHTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  <table ref={ref} className={cn("w-full border-collapse text-left text-sm", className)} {...props} />
));
DataTable.displayName = "DataTable";

const DataTableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn("bg-shell/70 text-[11px] uppercase tracking-wide text-text-muted", className)}
    {...props}
  />
));
DataTableHeader.displayName = "DataTableHeader";

const DataTableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => <tbody ref={ref} className={className} {...props} />);
DataTableBody.displayName = "DataTableBody";

const DataTableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn("border-b border-border-subtle transition-colors hover:bg-hover/70", className)}
    {...props}
  />
));
DataTableRow.displayName = "DataTableRow";

const DataTableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th ref={ref} className={cn("h-10 px-3 font-medium", className)} {...props} />
));
DataTableHead.displayName = "DataTableHead";

const DataTableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & { mono?: boolean }
>(({ className, mono = false, ...props }, ref) => (
  <td
    ref={ref}
    className={cn("h-11 px-3 text-text-secondary", mono && "font-mono", className)}
    {...props}
  />
));
DataTableCell.displayName = "DataTableCell";

export {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DataTableShell,
};
