import { useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { openInNewTab, shouldOpenInNewTab } from "@/state/tabs";
import { useQuery } from "@tanstack/react-query";
import { Folders, RefreshCw, Search } from "lucide-react";
import { k8s } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DataTableShell,
  DataTable,
  DataTableHeader,
  DataTableBody,
  DataTableRow,
  DataTableHead,
  DataTableCell,
} from "@/components/ui/data-table";
import { LumenPage, PageHeader } from "@/components/lumen/page";

// `listNamespaces` returns string[] today — render a single-column table of
// names. Clicking a row navigates to the workloads view filtered to that
// namespace via the `ns` query param (the workloads route can pick this up
// in a follow-up — the URL is the source of truth either way).
export function NamespacesView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const nav = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState("");

  const goToNamespace = (ns: string, event: React.MouseEvent) => {
    const target = `/cluster/${encodeURIComponent(context)}/workloads?ns=${encodeURIComponent(ns)}`;
    if (shouldOpenInNewTab(event)) {
      openInNewTab(target, nav, location.pathname + location.search);
      return;
    }
    nav(target);
  };

  const queryKey = ["k8s", "namespaces-view", context];
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey,
    queryFn: () => k8s.listNamespaces(context || undefined),
    staleTime: 15_000,
  });

  const filtered = useMemo(() => {
    const list = data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((n) => n.toLowerCase().includes(q));
  }, [data, query]);

  return (
    <LumenPage>
      <PageHeader
        eyebrow="Cluster scope"
        title="namespaces"
        icon={<Folders className="size-3.5" aria-hidden="true" />}
        description={
          <>
            {context} · {data?.length ?? 0} namespace
            {data?.length === 1 ? "" : "s"}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter..."
              className="w-[180px] pl-7 text-xs"
            />
          </div>
          <Button
            onClick={() => refetch()}
            size="sm"
            disabled={isFetching}
          >
            <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
            refresh
          </Button>
        </div>
        }
      />

      <div>
        {error ? (
          <div className="rounded-control border border-danger/30 bg-[var(--status-error-soft)] p-4 text-[13px] text-danger">
            {(error as Error).message}
          </div>
        ) : isLoading ? (
          <div className="text-[13px] text-text-muted">loading namespaces...</div>
        ) : filtered.length === 0 ? (
          <div className="text-[13px] text-text-muted">
            {query ? "no namespaces match filter." : "no namespaces found."}
          </div>
        ) : (
          <DataTableShell>
            <DataTable>
              <DataTableHeader>
                <DataTableRow>
                  <DataTableHead>
                    name
                  </DataTableHead>
                </DataTableRow>
              </DataTableHeader>
              <DataTableBody>
                {filtered.map((ns) => (
                  <DataTableRow
                    key={ns}
                    onClick={(e) => goToNamespace(ns, e)}
                    onAuxClick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        goToNamespace(ns, e);
                      }
                    }}
                    title="Click to open · Cmd/Middle-click for new tab"
                    className="cursor-pointer"
                  >
                    <DataTableCell>
                      <div className="flex items-center gap-2">
                        <span className="size-2 rounded-full bg-success" />
                        <span className="text-[13px] text-text-primary font-medium">
                          {ns}
                        </span>
                      </div>
                    </DataTableCell>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          </DataTableShell>
        )}
      </div>
    </LumenPage>
  );
}
