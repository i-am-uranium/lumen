import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams, useSearchParams } from "react-router-dom";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  CircleDot,
  Download,
  Eraser,
  Pause,
  Play,
  Search,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";
import { k8s, type WorkloadKind } from "@/lib/k8s";
import { PodStrip } from "@/components/PodStrip";
import { LogLineRow } from "@/components/LogLineRow";
import { useLogsStore, type LogLine } from "@/state/logs";
import { cn } from "@/lib/utils";

const LOG_KINDS: { value: WorkloadKind; label: string }[] = [
  { value: "deployment", label: "deployments" },
  { value: "statefulset", label: "statefulsets" },
  { value: "daemonset", label: "daemonsets" },
  { value: "pod", label: "pods" },
];

/**
 * Pick a Kubernetes label selector likely to match the workload's pods. Most
 * teams stamp `app.kubernetes.io/name` on templates; we fall back to `app`
 * when the search text doesn't hit. For explicit pod selections the backend
 * bypasses the label selector and uses the pod name directly.
 */
function selectorFor(kind: WorkloadKind, name: string): string | undefined {
  if (kind === "pod") return undefined;
  return `app.kubernetes.io/name=${name}`;
}

export function LogsTab() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const loc = useLocation();
  const [sp, setSp] = useSearchParams();

  const [namespace, setNamespace] = useState<string>(sp.get("ns") ?? "");
  const [kind, setKind] = useState<WorkloadKind>(
    (sp.get("kind") as WorkloadKind) ?? "deployment",
  );
  const [name, setName] = useState<string>(sp.get("name") ?? "");
  const [container, setContainer] = useState<string | null>(
    sp.get("c") || null,
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");

  // Persist selection in the URL so deep-links from CloudMap work.
  useEffect(() => {
    const next = new URLSearchParams();
    if (namespace) next.set("ns", namespace);
    if (kind) next.set("kind", kind);
    if (name) next.set("name", name);
    if (container) next.set("c", container);
    setSp(next, { replace: true });
    // loc.pathname intentionally omitted — setSearchParams is stable.
  }, [namespace, kind, name, container, setSp, loc.pathname]);

  // Reset container when the workload selection changes — the previously
  // picked container probably doesn't exist on a different pod.
  useEffect(() => {
    setContainer(null);
  }, [namespace, kind, name]);

  // Fetch containers when a pod is selected (or the first pod of a workload
  // label selector — we only offer explicit picking in the pod case for
  // now, since for Deployment/STS/DS each pod may have the same shape).
  const containersQuery = useQuery({
    queryKey: ["k8s", "pod-containers", context, namespace, name],
    queryFn: () =>
      k8s.listPodContainers(namespace, name, context || undefined),
    enabled: kind === "pod" && !!namespace && !!name,
    staleTime: 60_000,
  });

  const { data: namespaces = [] } = useQuery({
    queryKey: ["k8s", "namespaces", context],
    queryFn: () => k8s.listNamespaces(context || undefined),
    staleTime: 60_000,
  });
  const { data: workloads = [], isLoading: loadingWl } = useQuery({
    queryKey: ["k8s", "workloads", context, namespace, kind],
    queryFn: () => k8s.listWorkloads(namespace, kind, context || undefined),
    enabled: !!namespace,
    staleTime: 15_000,
  });

  const filteredWorkloads = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workloads;
    return workloads.filter((w) => w.name.toLowerCase().includes(q));
  }, [workloads, query]);

  const streamId = useMemo(
    () =>
      namespace && name
        ? `logs-${context}-${namespace}-${kind}-${name}-${container ?? "default"}`
        : null,
    [context, namespace, kind, name, container],
  );

  const { openStream, closeStream, appendLine, setPaused, toggleMute, streams } =
    useLogsStore();
  const state = streamId ? streams[streamId] : undefined;

  // Stream lifecycle. Ingest is unconditional — pausing only suspends the
  // auto-scroll, it does NOT drop incoming lines. Previously a paused tab
  // silently lost events between pause and resume; users complained that
  // "scroll up to read a line" caused later traffic to vanish.
  useEffect(() => {
    if (!streamId) return;
    openStream(streamId);
    const ch = new Channel<LogLine>();
    ch.onmessage = (line) => {
      const st = useLogsStore.getState().streams[streamId];
      if (!st) return;
      appendLine(streamId, line);
    };
    invoke("stream_logs", {
      selector: {
        namespace,
        label_selector: selectorFor(kind, name),
        pod_name: kind === "pod" ? name : null,
        container,
        since_seconds: 600,
        tail_lines: 500,
      },
      streamId,
      channel: ch,
      context: context || undefined,
    }).catch((e) => toast.error(`log stream failed: ${e}`));
    return () => {
      invoke("stop_stream", { streamId });
      closeStream(streamId);
    };
  }, [streamId, namespace, kind, name, container, context, openStream, closeStream, appendLine]);

  // Filtered view.
  const filterLc = filter.trim().toLowerCase();
  const visibleLines = useMemo(() => {
    const buf = state?.buffer ?? [];
    return buf.filter(
      (l) =>
        !state?.mutedPods.has(l.pod) &&
        (!filterLc || l.text.toLowerCase().includes(filterLc)),
    );
  }, [state?.buffer, state?.mutedPods, filterLc]);

  const pods = useMemo(
    () => Array.from(new Set((state?.buffer ?? []).map((l) => l.pod))),
    [state?.buffer],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: visibleLines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 26,
    overscan: 20,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 26,
  });
  useEffect(() => {
    if (state?.paused) return;
    rowVirtualizer.scrollToIndex(visibleLines.length - 1, { align: "end" });
  }, [visibleLines.length, state?.paused, rowVirtualizer]);

  // Scroll-aware follow: when the user scrolls up away from the tail, pause
  // auto-scroll automatically; when they scroll back to ~bottom, resume.
  // 64px tolerance covers the inertial-scroll overshoot on macOS trackpads.
  useEffect(() => {
    if (!streamId) return;
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distance < 64;
      const st = useLogsStore.getState().streams[streamId];
      if (!st) return;
      if (atBottom && st.paused) setPaused(streamId, false);
      else if (!atBottom && !st.paused) setPaused(streamId, true);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [streamId, setPaused]);

  const jumpToLive = useCallback(() => {
    if (!streamId) return;
    rowVirtualizer.scrollToIndex(visibleLines.length - 1, { align: "end" });
    setPaused(streamId, false);
  }, [streamId, visibleLines.length, rowVirtualizer, setPaused]);

  const download = useCallback(() => {
    if (!state || !state.buffer.length) {
      toast.error("nothing to download yet");
      return;
    }
    const lines = state.buffer
      .filter((l) => !state.mutedPods.has(l.pod))
      .map((l) => `${l.pod}/${l.container}\t${l.text}`);
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `${context}-${namespace}-${kind}-${name}-${stamp}.log`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`downloaded ${lines.length} lines`);
  }, [state, context, namespace, kind, name]);

  const clear = useCallback(() => {
    if (!streamId) return;
    // Cheap re-open: close + open produces a fresh stream state.
    closeStream(streamId);
    openStream(streamId);
  }, [streamId, closeStream, openStream]);

  return (
    <div className="flex h-full min-h-0">
      {/* Left picker */}
      <aside className="w-[300px] border-r border-term-border-soft bg-term-panel flex flex-col min-h-0">
        <div className="px-4 h-12 flex items-center border-b border-term-border-soft shrink-0">
          <h2 className="mds-heading text-[14px] text-term-fg flex items-center gap-2">
            <Terminal className="size-4" /> logs
          </h2>
        </div>

        <div className="p-3 space-y-3 border-b border-term-border-soft">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-term-subtle mb-1">
              namespace
            </label>
            <select
              value={namespace}
              onChange={(e) => {
                setNamespace(e.target.value);
                setName("");
              }}
              className="w-full h-8 px-2 rounded-md bg-term-bg border border-term-border-soft text-[12px] text-term-fg"
            >
              <option value="">— select —</option>
              {namespaces.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-term-subtle mb-1">
              kind
            </label>
            <div className="grid grid-cols-2 gap-1">
              {LOG_KINDS.map((k) => (
                <button
                  key={k.value}
                  onClick={() => {
                    setKind(k.value);
                    setName("");
                  }}
                  className={cn(
                    "h-7 text-[11px] rounded-md border",
                    kind === k.value
                      ? "border-term-green/60 bg-term-green-soft text-term-green"
                      : "border-term-border-soft text-term-muted hover:bg-term-panel-2",
                  )}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-term-subtle mb-1">
              filter
            </label>
            <div className="flex items-center gap-2 h-8 px-2 rounded-md bg-term-bg border border-term-border-soft">
              <Search className="size-3.5 text-term-subtle" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter workloads..."
                className="flex-1 bg-transparent outline-none text-[12px] text-term-fg placeholder:text-term-subtle"
              />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!namespace ? (
            <div className="p-3 text-[12px] text-term-muted">
              pick a namespace to list {LOG_KINDS.find((k) => k.value === kind)?.label}.
            </div>
          ) : loadingWl ? (
            <div className="p-3 text-[12px] text-term-muted">loading…</div>
          ) : filteredWorkloads.length === 0 ? (
            <div className="p-3 text-[12px] text-term-muted">
              no {kind}s found in {namespace}.
            </div>
          ) : (
            filteredWorkloads.map((w) => (
              <button
                key={w.name}
                onClick={() => setName(w.name)}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 hover:bg-term-panel-2 transition-colors",
                  name === w.name && "bg-term-green-soft",
                )}
              >
                <span
                  className={cn(
                    "size-2 rounded-full shrink-0",
                    w.health === "healthy"
                      ? "bg-emerald-400"
                      : w.health === "degraded"
                        ? "bg-amber-400"
                        : w.health === "failed"
                          ? "bg-term-red"
                          : "bg-term-subtle",
                  )}
                />
                <span
                  className={cn(
                    "text-term-fg truncate font-mono",
                    name === w.name && "text-term-green",
                  )}
                >
                  {w.name}
                </span>
                <span className="ml-auto text-term-subtle text-[11px] tabular-nums">
                  {w.ready}
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Main log stream */}
      <main className="flex-1 flex flex-col min-w-0 min-h-0">
        {!state ? (
          <div className="flex-1 flex items-center justify-center text-center text-term-muted">
            <div className="flex flex-col items-center gap-2">
              <Terminal className="size-5" />
              <p className="text-[13px]">select a workload on the left to tail its logs</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 h-12 px-4 border-b border-term-border-soft bg-term-panel shrink-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="text-term-subtle font-mono">{namespace}</span>
                  <span className="text-term-subtle">/</span>
                  <span className="text-term-subtle uppercase text-[10px] tracking-wider">
                    {kind}
                  </span>
                  <span className="text-term-subtle">/</span>
                  <span className="text-term-fg font-mono truncate">{name}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-term-muted">
                  <CircleDot
                    className={cn(
                      "size-3",
                      state.paused ? "text-term-subtle" : "text-emerald-400 animate-pulse",
                    )}
                  />
                  {state.paused ? "paused" : "live"} · {state.buffer.length} lines buffered
                  {filterLc && ` · ${visibleLines.length} match`}
                </div>
              </div>
              <div className="flex-1" />
              {kind === "pod" &&
                containersQuery.data &&
                containersQuery.data.length > 1 && (
                  <select
                    value={container ?? ""}
                    onChange={(e) => setContainer(e.target.value || null)}
                    className="h-8 px-2 text-[12px] rounded-md bg-term-bg border border-term-border-soft text-term-fg"
                    title="container"
                  >
                    <option value="">default</option>
                    {containersQuery.data.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                        {c.is_init ? " (init)" : ""}
                        {c.is_default ? " ★" : ""}
                      </option>
                    ))}
                  </select>
                )}
              <div className="flex items-center gap-2 h-8 px-2 rounded-md bg-term-bg border border-term-border-soft w-[260px]">
                <Search className="size-3.5 text-term-subtle" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="grep..."
                  className="flex-1 bg-transparent outline-none text-[12px] text-term-fg placeholder:text-term-subtle"
                />
              </div>
              <button
                onClick={() => streamId && setPaused(streamId, !state.paused)}
                className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
                title={state.paused ? "resume" : "pause"}
              >
                {state.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                {state.paused ? "resume" : "pause"}
              </button>
              <button
                onClick={clear}
                className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
                title="clear buffer"
              >
                <Eraser className="size-3.5" />
              </button>
              <button
                onClick={download}
                className="term-btn term-btn-primary !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
                disabled={!state.buffer.length}
              >
                <Download className="size-3.5" /> download
              </button>
            </div>

            <PodStrip
              pods={pods}
              colorByPod={Object.fromEntries(
                Object.entries(state.colorByPod).map(([k, v]) => [k, v.replace("text-", "bg-")]),
              )}
              mutedPods={state.mutedPods}
              onToggleMute={(pod) => streamId && toggleMute(streamId, pod)}
            />

            <div className="relative flex-1 min-h-0">
            {state.paused && (
              <button
                onClick={jumpToLive}
                className="absolute left-1/2 -translate-x-1/2 bottom-3 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-term-green/40 bg-term-green/10 text-[11px] text-term-green hover:bg-term-green/20 transition-colors shadow-md"
              >
                <ArrowDown className="size-3" /> jump to live
              </button>
            )}
            <div
              ref={parentRef}
              className="absolute inset-0 overflow-auto font-mono bg-term-bg"
            >
              {visibleLines.length === 0 ? (
                <div className="p-4 text-[12px] text-term-muted">
                  {filterLc
                    ? "no lines match the current filter."
                    : "waiting for first line…"}
                </div>
              ) : (
                <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                  {rowVirtualizer.getVirtualItems().map((v) => {
                    const line = visibleLines[v.index];
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
                        <LogLineRow
                          line={line}
                          color={state.colorByPod[line.pod] ?? "text-term-subtle"}
                          highlight={filterLc}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
