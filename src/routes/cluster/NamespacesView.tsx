import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Folders, RefreshCw, Search } from "lucide-react";
import { k8s } from "@/lib/k8s";
import { cn } from "@/lib/utils";

// `listNamespaces` returns string[] today — render a single-column table of
// names. Clicking a row navigates to the workloads view filtered to that
// namespace via the `ns` query param (the workloads route can pick this up
// in a follow-up — the URL is the source of truth either way).
export function NamespacesView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const nav = useNavigate();
  const [query, setQuery] = useState("");

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
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-term-bg/95 backdrop-blur border-b border-term-border-soft flex items-center justify-between px-6 py-4">
        <div>
          <h1 className="mds-heading text-[20px] text-term-fg flex items-center gap-2">
            <Folders className="size-5" /> namespaces
          </h1>
          <p className="text-[12px] text-term-muted">
            {context} · {data?.length ?? 0} namespace
            {data?.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-term-subtle" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter…"
              className="bg-term-panel border border-term-border-soft rounded text-[12px] text-term-fg placeholder:text-term-subtle pl-7 pr-2 py-1.5 min-h-[32px] w-[180px] focus:outline-none focus:border-term-green/60"
            />
          </div>
          <button
            onClick={() => refetch()}
            className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
            disabled={isFetching}
          >
            <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />{" "}
            refresh
          </button>
        </div>
      </div>

      <div className="p-6">
        {error ? (
          <div className="rounded-lg border border-term-red/40 bg-term-red/10 p-4 text-[13px] text-term-red">
            {(error as Error).message}
          </div>
        ) : isLoading ? (
          <div className="text-[13px] text-term-muted">loading namespaces...</div>
        ) : filtered.length === 0 ? (
          <div className="text-[13px] text-term-muted">
            {query ? "no namespaces match filter." : "no namespaces found."}
          </div>
        ) : (
          <div className="rounded-lg border border-term-border-soft overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-term-panel">
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wider text-term-subtle">
                    name
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((ns) => (
                  <tr
                    key={ns}
                    onClick={() =>
                      nav(
                        `/cluster/${encodeURIComponent(context)}/workloads?ns=${encodeURIComponent(ns)}`,
                      )
                    }
                    className="border-b border-term-border-soft hover:bg-term-panel-2 cursor-pointer last:border-b-0"
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="size-2 rounded-full bg-emerald-400" />
                        <span className="text-[13px] text-term-fg font-medium">
                          {ns}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
