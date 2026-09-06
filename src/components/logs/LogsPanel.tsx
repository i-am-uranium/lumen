import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { LogStream, captureLogSnapshot, logErrorMessage } from "@/state/logStream";
import { useTabView } from "@/hooks/useTabView";
import { LogsToolbar, type Level } from "./LogsToolbar";
import { LogsRowList } from "./LogsRowList";
import type { ContainerOption } from "./LogsContainerPills";

export type LogsPanelProps = {
  /** Kubernetes context. Passed through to stream_logs. */
  ctx: string;
  namespace: string;
  pod: string;
  containers: ContainerOption[];
  /** For the download filename. */
  resourceName: string;
  /** Render the 3px pod-color gutter on rows. Used by Phase 4 split view. */
  gutterColor?: string;
};

export function LogsPanel(props: LogsPanelProps) {
  const { ctx, namespace, pod, containers, resourceName } = props;

  const [containerSelection, setContainerSelection] = useState<"all" | string[]>("all");
  const [search, setSearch] = useState({ query: "", regex: false, caseSensitive: false });
  const [currentMatch, setCurrentMatch] = useState(0);
  const [levels, setLevels] = useState<Set<Level>>(
    new Set(["error", "warn", "info", "debug"]),
  );
  const [rangeSeconds, setRangeSeconds] = useState<number | null>(60 * 60);
  const [previous, setPrevious] = useState(false);
  const [paused, setPaused] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [timestamps, setTimestamps] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [streamsTick, setStreamsTick] = useState(0);

  // Derive active container names.
  const activeContainerNames = useMemo(() => {
    if (containerSelection === "all") return containers.map((c) => c.name);
    return containerSelection;
  }, [containerSelection, containers]);

  // Manage one LogStream per (pod, active container).
  const streamsRef = useRef<Map<string, LogStream>>(new Map());
  useEffect(() => {
    const wanted = new Set(activeContainerNames);
    const map = streamsRef.current;
    for (const [name, s] of map) {
      if (!wanted.has(name) || s.pod !== pod || s.namespace !== namespace || s.context !== ctx ||
          s.sinceSeconds !== (previous ? null : rangeSeconds) || s.previous !== previous) {
        s.stop();
        map.delete(name);
      }
    }
    for (const name of wanted) {
      if (!map.has(name)) {
        const s = new LogStream({
          pod,
          container: name,
          namespace,
          context: ctx,
          // Previous logs are a one-shot read of a fixed slice — slicing by
          // sinceSeconds doesn't make sense, so pass null to surface the
          // whole retained log.
          sinceSeconds: previous ? null : rangeSeconds,
          tailLines: 500,
          previous,
        });
        s.start();
        map.set(name, s);
      }
    }
    setStreamsTick((t) => t + 1);
  }, [activeContainerNames, namespace, pod, ctx, rangeSeconds, previous]);

  useEffect(() => {
    return () => {
      for (const s of streamsRef.current.values()) s.stop();
      streamsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    for (const s of streamsRef.current.values()) {
      if (paused) s.pause();
      else s.resume();
    }
  }, [paused, streamsTick]);

  const streams = useMemo(
    () => Array.from(streamsRef.current.values()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streamsTick],
  );

  // Level filter is "off" when all four levels are selected (default state) — pass
  // null so mergeAndFilter skips the filter pass entirely.
  const allLevelsOn = (["error", "warn", "info", "debug"] as Level[]).every((l) =>
    levels.has(l),
  );
  const view = useTabView(streams, {
    query: search.query,
    regex: search.regex,
    caseSensitive: search.caseSensitive,
    levels: allLevelsOn ? null : (levels as Set<string>),
  });

  // Reset currentMatch when matches change.
  useEffect(() => {
    if (currentMatch >= view.matches.length) setCurrentMatch(0);
  }, [view.matches.length, currentMatch]);

  function onSearchPrev() {
    if (view.matches.length === 0) return;
    setCurrentMatch((c) => (c - 1 + view.matches.length) % view.matches.length);
  }
  function onSearchNext() {
    if (view.matches.length === 0) return;
    setCurrentMatch((c) => (c + 1) % view.matches.length);
  }
  function onClear() {
    for (const s of streamsRef.current.values()) s.clear();
    setStreamsTick((t) => t + 1);
  }

  async function onDownload() {
    if (downloading) return;
    setDownloading(true);
    try {
      const lines = await captureLogSnapshot({ namespace, pod, context: ctx, previous });
      const blob = new Blob([lines.join("\n")], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${namespace}-${resourceName}.log`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(`Log download failed: ${logErrorMessage(error)}`);
    } finally {
      setDownloading(false);
    }
  }

  const pendingCount = streams.reduce((sum, s) => sum + s.getPendingCount(), 0);

  // Header-line "since" timestamp (panel mount time).
  const sinceRef = useRef<string>(new Date().toISOString().slice(11, 19));

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-3 py-1.5 border-b border-border-default bg-shell text-[11px] text-text-muted truncate">
        {namespace} / {pod} · since {sinceRef.current} · {view.lines.length.toLocaleString()} lines
        {paused && " · paused"}
        {streams.map((stream) => (
          <span key={stream.container} title={stream.errorMessage ?? undefined}>
            {` · ${stream.container}: ${stream.status}`}
            {stream.errorMessage && ` (${stream.errorMessage})`}
          </span>
        ))}
      </div>
      <LogsToolbar
        containers={containers}
        containerSelection={containerSelection}
        onContainerChange={setContainerSelection}
        search={search}
        matchCount={view.matches.length}
        currentMatch={currentMatch}
        regexError={view.regexError}
        onSearchChange={setSearch}
        onSearchPrev={onSearchPrev}
        onSearchNext={onSearchNext}
        levels={levels}
        onLevelToggle={(l) => {
          const next = new Set(levels);
          if (next.has(l)) next.delete(l);
          else next.add(l);
          setLevels(next);
        }}
        rangeSeconds={rangeSeconds}
        onRangeChange={setRangeSeconds}
        previous={previous}
        onPreviousToggle={() => setPrevious((p) => !p)}
        paused={paused}
        onPauseToggle={() => setPaused((p) => !p)}
        pendingCount={pendingCount}
        onClear={onClear}
        wrap={wrap}
        onWrapToggle={() => setWrap((w) => !w)}
        timestamps={timestamps}
        onTimestampsToggle={() => setTimestamps((t) => !t)}
        onDownload={onDownload}
        downloading={downloading}
      />
      <LogsRowList
        lines={view.lines}
        search={search.query}
        podColors={props.gutterColor ? { [pod]: props.gutterColor } : {}}
        showGutter={!!props.gutterColor}
      />
    </div>
  );
}
