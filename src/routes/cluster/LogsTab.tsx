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
import { useLogsStore } from "@/state/logs";
import { type LogStreamEvent, type LogStreamStatus, logErrorMessage } from "@/state/logStream";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const [filter, setFilter] = useState(sp.get("grep") ?? "");

  // Persist selection in the URL so deep-links from CloudMap work.
  useEffect(() => {
    const next = new URLSearchParams();
    if (namespace) next.set("ns", namespace);
    if (kind) next.set("kind", kind);
    if (name) next.set("name", name);
    if (container) next.set("c", container);
    if (filter) next.set("grep", filter);
    setSp(next, { replace: true });
    // loc.pathname intentionally omitted — setSearchParams is stable.
  }, [namespace, kind, name, container, filter, setSp, loc.pathname]);

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
    enabled: !!namespace || !!name,
    staleTime: 15_000,
  });

  const filteredWorkloads = useMemo(() => {
    const q = (query.trim() || (!namespace ? name : "")).toLowerCase();
    if (!q) return workloads;
    return workloads.filter((w) => w.name.toLowerCase().includes(q));
  }, [workloads, query, namespace, name]);

  useEffect(() => {
    if (namespace || !name || loadingWl) return;
    const exactMatches = workloads.filter((w) => w.name === name);
    if (exactMatches.length === 1) {
      setNamespace(exactMatches[0].namespace);
      setName(exactMatches[0].name);
    }
  }, [namespace, name, loadingWl, workloads]);

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
  const [streamStatus, setStreamStatus] = useState<LogStreamStatus>("connecting");
  const [streamError, setStreamError] = useState<string | null>(null);

  // Stream lifecycle. Ingest is unconditional — pausing only suspends the
  // auto-scroll, it does NOT drop incoming lines. Previously a paused tab
  // silently lost events between pause and resume; users complained that
  // "scroll up to read a line" caused later traffic to vanish.
  useEffect(() => {
    if (!streamId) return;
    openStream(streamId);
    let active = true;
    const backendId = `${streamId}-${crypto.randomUUID()}`;
    const podStatuses = new Map<string, { status: LogStreamStatus; message?: string | null }>();
    setStreamStatus("connecting");
    setStreamError(null);
    const ch = new Channel<LogStreamEvent>();
    ch.onmessage = (line) => {
      if (!active) return;
      if ("type" in line && line.type === "status") {
        if (!line.pod && (line.status === "error" || line.status === "ended")) {
          setStreamStatus(line.status);
          setStreamError(line.message ?? null);
        } else {
          podStatuses.set(line.pod, line);
          const statuses = [...podStatuses.values()];
          const status = (["error", "retrying", "live", "connecting", "ended"] as const)
            .find((status) => statuses.some((entry) => entry.status === status)) ?? "connecting";
          setStreamStatus(status);
          setStreamError(status === "error" || status === "retrying"
            ? statuses.find((entry) => entry.status === status)?.message ?? null : null);
        }
        return;
      }
      if (!("text" in line)) return;
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
      streamId: backendId,
      channel: ch,
      context: context || undefined,
    }).then(() => {
      if (!active) invoke("stop_stream", { streamId: backendId }).catch(() => {});
    }).catch((e) => {
      if (!active) return;
      setStreamStatus("error");
      setStreamError(logErrorMessage(e));
      toast.error(`log stream failed: ${logErrorMessage(e)}`);
    });
    return () => {
      active = false;
      invoke("stop_stream", { streamId: backendId }).catch(() => {});
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
      <aside className="w-[300px] border-r border-border-default bg-surface flex flex-col min-h-0">
        <div className="px-4 h-12 flex items-center border-b border-border-default shrink-0">
          <h2 className="mds-heading text-[14px] text-text-primary flex items-center gap-2">
            <Terminal className="size-4" /> logs
          </h2>
        </div>

        <div className="p-3 space-y-3 border-b border-border-default">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1">
              namespace
            </label>
            <select
              value={namespace}
              onChange={(e) => {
                setNamespace(e.target.value);
                setName("");
              }}
              className="w-full h-8 px-2 rounded-control bg-elevated border border-border-default text-[12px] text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/45"
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
            <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1">
              kind
            </label>
            <div className="grid grid-cols-2 gap-1">
              {LOG_KINDS.map((k) => (
                <Button
                  key={k.value}
                  type="button"
                  onClick={() => {
                    setKind(k.value);
                    setName("");
                  }}
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-7 text-[11px] rounded-control",
                    kind === k.value
                      ? "border-accent-primary/60 bg-accent-primary-soft text-accent-primary"
                      : "text-text-secondary hover:text-text-primary",
                  )}
                >
                  {k.label}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1">
              filter
            </label>
            <div className="flex items-center gap-2 h-8 px-2 rounded-control bg-elevated border border-border-default">
              <Search className="size-3.5 text-text-muted" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter workloads..."
                className="h-7 flex-1 border-0 bg-transparent px-0 text-[12px] shadow-none focus-visible:ring-0"
              />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!namespace && !name ? (
            <div className="p-3 text-[12px] text-text-secondary">
              pick a namespace to list {LOG_KINDS.find((k) => k.value === kind)?.label}.
            </div>
          ) : loadingWl ? (
            <div className="p-3 text-[12px] text-text-secondary">
              {namespace
                ? "loading..."
                : `looking for ${kind}/${name} across namespaces...`}
            </div>
          ) : filteredWorkloads.length === 0 ? (
            <div className="p-3 text-[12px] text-text-secondary">
              {namespace
                ? `no ${kind}s found in ${namespace}.`
                : `no ${kind} named ${name} found across namespaces.`}
            </div>
          ) : (
            filteredWorkloads.map((w) => (
              <button
                key={`${w.namespace}-${w.name}`}
                onClick={() => {
                  setNamespace(w.namespace);
                  setName(w.name);
                }}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 hover:bg-hover transition-colors",
                  namespace === w.namespace && name === w.name && "bg-accent-primary-soft",
                )}
              >
                <span
                  className={cn(
                    "size-2 rounded-full shrink-0",
                    w.health === "healthy"
                      ? "bg-success"
                      : w.health === "degraded"
                        ? "bg-warning"
                        : w.health === "failed"
                          ? "bg-danger"
                          : "bg-text-muted",
                  )}
                />
                <span
                  className={cn(
                    "text-text-primary truncate font-mono",
                    namespace === w.namespace && name === w.name && "text-accent-primary",
                  )}
                >
                  {w.name}
                </span>
                {!namespace && (
                  <span className="ml-auto text-text-muted text-[11px]">
                    {w.namespace}
                  </span>
                )}
                <span
                  className={cn(
                    "text-text-muted text-[11px] tabular-nums",
                    namespace && "ml-auto",
                  )}
                >
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
          <div className="flex-1 flex items-center justify-center text-center text-text-secondary">
            <div className="flex flex-col items-center gap-2">
              <Terminal className="size-5" />
              <p className="text-[13px]">select a workload on the left to tail its logs</p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 h-12 px-4 border-b border-border-default bg-surface shrink-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="text-text-muted font-mono">{namespace}</span>
                  <span className="text-text-muted">/</span>
                  <span className="text-text-muted uppercase text-[10px] tracking-wider">
                    {kind}
                  </span>
                  <span className="text-text-muted">/</span>
                  <span className="text-text-primary font-mono truncate">{name}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-text-secondary">
                  <CircleDot
                    className={cn(
                      "size-3",
                      state.paused || streamStatus !== "live" ? "text-text-muted" : "text-success animate-pulse",
                    )}
                  />
                  {streamStatus}{state.paused && " · paused"} · {state.buffer.length} lines buffered
                  {filterLc && ` · ${visibleLines.length} match`}
                  {streamError && <span title={streamError} className="truncate text-term-amber">{streamError}</span>}
                </div>
              </div>
              <div className="flex-1" />
              {kind === "pod" &&
                containersQuery.data &&
                containersQuery.data.length > 1 && (
                  <select
                    value={container ?? ""}
                    onChange={(e) => setContainer(e.target.value || null)}
                    className="h-8 px-2 text-[12px] rounded-control bg-elevated border border-border-default text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/45"
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
              <div className="flex items-center gap-2 h-8 px-2 rounded-control bg-elevated border border-border-default w-[260px]">
                <Search className="size-3.5 text-text-muted" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="grep..."
                  className="h-7 flex-1 border-0 bg-transparent px-0 text-[12px] shadow-none focus-visible:ring-0"
                />
              </div>
              <Button
                type="button"
                onClick={() => streamId && setPaused(streamId, !state.paused)}
                variant="secondary"
                size="sm"
                className="h-8 text-[12px]"
                title={state.paused ? "resume" : "pause"}
              >
                {state.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                {state.paused ? "resume" : "pause"}
              </Button>
              <Button
                type="button"
                onClick={clear}
                variant="secondary"
                size="icon"
                className="size-8"
                title="clear buffer"
              >
                <Eraser className="size-3.5" />
              </Button>
              <Button
                type="button"
                onClick={download}
                size="sm"
                className="h-8 text-[12px]"
                disabled={!state.buffer.length}
              >
                <Download className="size-3.5" /> download
              </Button>
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
                <Button
                  type="button"
                  onClick={jumpToLive}
                  variant="outline"
                  size="sm"
                  className="absolute left-1/2 -translate-x-1/2 bottom-3 z-10 h-8 rounded-full border-accent-primary/40 bg-accent-primary-soft text-[11px] text-accent-primary shadow-[var(--shadow-popover)]"
                >
                  <ArrowDown className="size-3" /> jump to live
                </Button>
              )}
              <div
                ref={parentRef}
                className="absolute inset-0 overflow-auto font-mono bg-shell"
              >
                {visibleLines.length === 0 ? (
                  <div className="p-4 text-[12px] text-text-secondary">
                    {filterLc
                      ? "no lines match the current filter."
                      : "waiting for first line..."}
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
                            color={state.colorByPod[line.pod] ?? "text-text-muted"}
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
