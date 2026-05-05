import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Info, RefreshCw, X } from "lucide-react";
import { k8s, type EventSummary, type WorkloadKind } from "@/lib/k8s";
import { cn } from "@/lib/utils";

type Props = {
  context: string;
  namespace: string;
  kind: WorkloadKind;
  name: string;
  onClose: () => void;
};

/**
 * Direct-involvement events modal. Uses the apiserver's field-selector so we
 * only see events whose `involvedObject` matches this resource — no noise
 * from siblings in the namespace.
 */
export function EventsModal({ context, namespace, kind, name, onClose }: Props) {
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["k8s", "events-for", context, namespace, kind, name],
    queryFn: () => k8s.listEventsFor(namespace, kind, name, context || undefined),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

  const counts = useMemo(() => {
    const out = { warning: 0, normal: 0 };
    for (const e of data ?? []) {
      if (e.type_ === "Warning") out.warning++;
      else out.normal++;
    }
    return out;
  }, [data]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-term-panel border border-term-border rounded-lg shadow-2xl max-w-4xl w-full max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-term-border-soft shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[12px] text-term-muted font-mono uppercase tracking-wider">
              events
            </span>
            <span className="text-term-subtle">·</span>
            <span className="text-[12px] text-term-fg truncate">
              {namespace}/{kind}/{name}
            </span>
            <span className="text-term-subtle">·</span>
            <span className="text-[11px] text-term-muted tabular-nums">
              {counts.normal} normal
              {counts.warning > 0 && (
                <span className="text-warning"> · {counts.warning} warning</span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="text-term-subtle hover:text-term-fg"
              title="refresh"
            >
              <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
            </button>
            <button onClick={onClose} className="text-term-subtle hover:text-term-fg">
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {error ? (
            <div className="p-4 text-[12px] text-term-red">{(error as Error).message}</div>
          ) : isLoading ? (
            <div className="p-4 text-[12px] text-term-muted">loading events…</div>
          ) : (data ?? []).length === 0 ? (
            <div className="p-8 text-center text-[12px] text-term-muted">
              no direct events for this resource in the last retention window.
            </div>
          ) : (
            <ul className="divide-y divide-term-border-soft">
              {(data ?? []).map((e, i) => (
                <EventRow key={i} e={e} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function EventRow({ e }: { e: EventSummary }) {
  const isWarn = e.type_ === "Warning";
  return (
    <li className="px-4 py-2.5 flex items-start gap-3 hover:bg-term-panel-2">
      <span
        className={cn(
          "shrink-0 mt-0.5",
          isWarn ? "text-warning" : "text-term-subtle",
        )}
      >
        {isWarn ? <AlertTriangle className="size-3.5" /> : <Info className="size-3.5" />}
      </span>
      <div className="flex-1 min-w-0 text-[12px]">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              "px-1.5 py-0.5 text-[10px] rounded font-semibold uppercase tracking-wide border",
              isWarn
                ? "bg-warning-soft text-warning border-warning/40"
                : "bg-elevated text-text-secondary border-border-default",
            )}
          >
            {e.reason}
          </span>
          {e.count && e.count > 1 && (
            <span className="text-[10px] text-term-subtle">×{e.count}</span>
          )}
          <span className="text-[11px] text-term-subtle tabular-nums ml-auto">
            {e.ts ? new Date(e.ts).toLocaleString() : "—"}
          </span>
        </div>
        <p className="mt-0.5 text-term-fg break-words">{e.message}</p>
      </div>
    </li>
  );
}
