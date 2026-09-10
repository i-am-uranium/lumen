import { useState } from "react";
import { Button } from "@/components/ui/button";

const PAGE_SIZE = 50;
export function useDevicePagination<T>(items: readonly T[], scope: string) {
  const [selection, setSelection] = useState({ scope, page: 0 });
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page =
    selection.scope === scope ? Math.min(selection.page, pages - 1) : 0;
  // Reset before rendering a different scope and persist clamps after refresh.
  if (selection.scope !== scope || selection.page !== page)
    setSelection({ scope, page });
  return {
    items: items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    page,
    pages,
    total: items.length,
    first: items.length ? page * PAGE_SIZE + 1 : 0,
    last: Math.min(items.length, (page + 1) * PAGE_SIZE),
    setPage: (next: number) =>
      setSelection({ scope, page: Math.max(0, Math.min(next, pages - 1)) }),
  };
}

export function DevicePagination({
  pagination,
  label,
}: {
  pagination: Omit<ReturnType<typeof useDevicePagination>, "items">;
  label: string;
}) {
  if (!pagination.total) return null;
  return (
    <nav
      aria-label={`${label} pagination`}
      className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3"
    >
      <span className="text-xs text-text-muted" aria-live="polite">
        {pagination.first}–{pagination.last} of {pagination.total} {label}
      </span>
      {pagination.pages > 1 && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Previous ${label} page`}
            disabled={pagination.page === 0}
            onClick={() => pagination.setPage(pagination.page - 1)}
          >
            Previous
          </Button>
          <span className="text-xs text-text-muted">
            Page {pagination.page + 1} of {pagination.pages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Next ${label} page`}
            disabled={pagination.page + 1 >= pagination.pages}
            onClick={() => pagination.setPage(pagination.page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </nav>
  );
}
