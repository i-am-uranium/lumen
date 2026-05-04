import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  Eraser,
  Info,
  RefreshCw,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { k8s } from "@/lib/k8s";
import { cn } from "@/lib/utils";

/**
 * EventLine matches the shape emitted by the Rust `stream_events` channel
 * (see src-tauri/src/k8s/events.rs). Kept local because it isn't exposed
 * via the typed `k8s` wrapper today; the wrapper only covers list/RPC
 * endpoints, not the streaming channels (logs, helm, etc. follow the same
 * pattern of inlining their event types where they're consumed).
 */
type EventLine = {
  ts: string | null;
  kind: string;
  reason: string;
  message: string;
  involved: string;
  type_: string;
};

type Severity = "all" | "Normal" | "Warning";

const MAX_BUFFER = 1000;
const SCROLL_TOLERANCE = 64;

function relTime(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function splitInvolved(involved: string): { kind: string; name: string } {
  const ix = involved.indexOf("/");
  if (ix < 0) return { kind: involved, name: "" };
  return { kind: involved.slice(0, ix), name: involved.slice(ix + 1) };
}

/**
 * Cluster-wide events feed. The backend `stream_events` accepts an optional
 * namespace: when null, it watches Events cluster-wide via `Api::all`; when
 * set, it scopes the watch to that namespace. The dropdown defaults to "all
 * namespaces" (sentinel: empty string in UI → null on the wire).
 */
export function EventsView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const [sp, setSp] = useSearchParams();

  const [namespace, setNamespace] = useState<string>(sp.get("ns") ?? "");
  const [filter, setFilter] = useState("");
  const [severity, setSeverity] = useState<Severity>("all");
  const [events, setEvents] = useState<EventLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Persist namespace in URL so deep-links from other views work.
  useEffect(() => {
    const next = new URLSearchParams();
    if (namespace) next.set("ns", namespace);
    setSp(next, { replace: true });
  }, [namespace, setSp]);

  // Tick "now" every 5s so relative timestamps stay fresh without
  // re-rendering on every incoming event.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  const { data: namespaces = [] } = useQuery({
    queryKey: ["k8s", "namespaces", context],
    queryFn: () => k8s.listNamespaces(context || undefined),
    staleTime: 60_000,
  });

  const streamId = useMemo(
    () => `events-${context}-${namespace || "all"}`,
    [context, namespace],
  );

  // Stream lifecycle. Newest first: prepend incoming events, cap buffer at
  // MAX_BUFFER. Pausing only suspends auto-scroll; ingest never stops so
  // the user doesn't silently lose events while reading older ones.
  useEffect(() => {
    setEvents([]);
    const ch = new Channel<EventLine>();
    ch.onmessage = (line) => {
      setEvents((prev) => {
        const next = [line, ...prev];
        if (next.length > MAX_BUFFER) next.length = MAX_BUFFER;
        return next;
      });
    };
    invoke("stream_events", {
      namespace: namespace || null,
      streamId,
      channel: ch,
      context: context || undefined,
    }).catch((e) => toast.error(`event stream failed: ${e}`));
    return () => {
      invoke("stop_stream", { streamId }).catch(() => {});
    };
  }, [streamId, namespace, context]);

  const filterLc = filter.trim().toLowerCase();
  const visibleEvents = useMemo(() => {
    return events.filter((e) => {
      if (severity !== "all" && e.type_ !== severity) return false;
      if (!filterLc) return true;
      return (
        e.reason.toLowerCase().includes(filterLc) ||
        e.message.toLowerCase().includes(filterLc) ||
        e.involved.toLowerCase().includes(filterLc)
      );
    });
  }, [events, severity, filterLc]);

  const counts = useMemo(() => {
    let warn = 0;
    let normal = 0;
    for (const e of events) {
      if (e.type_ === "Warning") warn++;
      else normal++;
    }
    return { warn, normal };
  }, [events]);

  // Virtualized list. Mirrors LogsTab.tsx — only this view and LogsTab use
  // virtualization in the codebase, and react-virtual is already on disk.
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: visibleEvents.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 16,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 48,
  });

  // Auto-scroll to top on new event when at top; pause if user scrolls down.
  // Newest is index 0, so "at top" is scrollTop ≈ 0.
  useEffect(() => {
    if (paused) return;
    rowVirtualizer.scrollToIndex(0, { align: "start" });
  }, [visibleEvents.length, paused, rowVirtualizer]);

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const atTop = el.scrollTop < SCROLL_TOLERANCE;
      setPaused((p) => {
        if (atTop && p) return false;
        if (!atTop && !p) return true;
        return p;
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const jumpToTop = useCallback(() => {
    rowVirtualizer.scrollToIndex(0, { align: "start" });
    setPaused(false);
  }, [rowVirtualizer]);

  const clear = useCallback(() => {
    setEvents([]);
  }, []);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="sticky top-0 z-10 bg-app/95 backdrop-blur border-b border-border-subtle px-6 py-4 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="mds-heading text-[20px] text-text-primary flex items-center gap-2">
              <Activity className="size-5" /> events
            </h1>
            <p className="text-[12px] text-text-secondary">
              {context}
              {` · ${namespace || "all namespaces"}`} · {counts.normal} normal
              {counts.warn > 0 && (
                <span className="text-warning"> · {counts.warn} warning</span>
              )}
              {!paused ? (
                <span className="text-success"> · live</span>
              ) : (
                <span className="text-text-muted"> · paused</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={clear}
              className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
              title="clear buffer"
              disabled={events.length === 0}
            >
              <Eraser className="size-3.5" /> clear
            </button>
            <button
              onClick={jumpToTop}
              className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
              title="scroll to newest"
              disabled={visibleEvents.length === 0}
            >
              <RefreshCw className="size-3.5" /> latest
            </button>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1">
              namespace
            </label>
            <select
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              className="h-8 px-2 rounded-control bg-app border border-border-subtle text-[12px] text-text-primary w-[220px]"
              title="empty selection streams cluster-wide events"
            >
              <option value="">all namespaces</option>
              {namespaces.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1">
              type
            </label>
            <div className="flex h-8 rounded-control border border-border-subtle overflow-hidden">
              {(["all", "Normal", "Warning"] as Severity[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setSeverity(s)}
                  className={cn(
                    "px-3 text-[11px] border-r last:border-r-0 border-border-subtle transition-colors",
                    severity === s
                      ? s === "Warning"
                        ? "bg-amber-500/15 text-warning"
                        : "bg-term-green-soft text-term-green"
                      : "text-text-secondary hover:bg-elevated",
                  )}
                >
                  {s.toLowerCase()}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1">
              filter
            </label>
            <div className="flex items-center gap-2 h-8 px-2 rounded-control bg-app border border-border-subtle">
              <Search className="size-3.5 text-text-muted" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="grep reason / message / object..."
                className="flex-1 bg-transparent outline-none text-[12px] text-text-primary placeholder:text-text-muted"
              />
              {filterLc && (
                <span className="text-[10px] text-text-muted tabular-nums">
                  {visibleEvents.length}/{events.length}
                </span>
              )}
            </div>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-text-muted">
          streaming {namespace ? `events from ${namespace}` : "events cluster-wide"}.
        </p>
      </div>

      <div className="relative flex-1 min-h-0">
        {paused && visibleEvents.length > 0 && (
          <button
            onClick={jumpToTop}
            className="absolute left-1/2 -translate-x-1/2 top-3 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-accent-primary/40 bg-term-green/10 text-[11px] text-term-green hover:bg-term-green/20 transition-colors shadow-md"
          >
            <ArrowUp className="size-3" /> jump to newest
          </button>
        )}
        <div ref={parentRef} className="absolute inset-0 overflow-auto bg-app">
          <div className="sticky top-0 z-[1] bg-shell border-b border-border-subtle grid grid-cols-[100px_90px_140px_220px_1fr] px-3 py-2 text-[10px] uppercase tracking-wider text-text-muted">
            <span>time</span>
            <span>type</span>
            <span>reason</span>
            <span>object</span>
            <span>message</span>
          </div>
          {visibleEvents.length === 0 ? (
            <div className="p-6 text-[12px] text-text-secondary">
              {events.length === 0
                ? "waiting for first event…"
                : "no events match the current filter."}
            </div>
          ) : (
            <div
              style={{
                height: rowVirtualizer.getTotalSize(),
                position: "relative",
              }}
            >
              {rowVirtualizer.getVirtualItems().map((v) => {
                const e = visibleEvents[v.index];
                return (
                  <div
                    key={v.key}
                    data-index={v.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${v.start}px)`,
                    }}
                  >
                    <EventRow e={e} now={now} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EventRow({ e, now }: { e: EventLine; now: number }) {
  const isWarn = e.type_ === "Warning";
  const { kind, name } = splitInvolved(e.involved);
  return (
    <div
      className={cn(
        "grid grid-cols-[100px_90px_140px_220px_1fr] gap-0 px-3 py-2 border-b border-border-subtle hover:bg-elevated text-[12px]",
        isWarn && "border-l-2 border-l-amber-400",
      )}
      title={e.message}
    >
      <span className="text-text-muted tabular-nums text-[11px]">
        {relTime(e.ts, now)}
      </span>
      <span>
        <span
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded font-semibold uppercase tracking-wide border",
            isWarn
              ? "bg-amber-500/10 text-warning border-amber-500/40"
              : "bg-elevated text-text-secondary border-border-subtle",
          )}
        >
          {isWarn ? (
            <AlertTriangle className="size-3" />
          ) : (
            <Info className="size-3" />
          )}
          {e.type_ || "—"}
        </span>
      </span>
      <span className="text-text-primary font-mono text-[11px] truncate" title={e.reason}>
        {e.reason || "—"}
      </span>
      <span className="min-w-0 truncate font-mono text-[11px]" title={e.involved}>
        <span className="text-text-muted uppercase">{kind || "—"}</span>
        {name && (
          <>
            <span className="text-text-muted">/</span>
            <span className="text-text-primary">{name}</span>
          </>
        )}
      </span>
      <span className="text-text-primary break-words pr-2 line-clamp-2">{e.message}</span>
    </div>
  );
}
