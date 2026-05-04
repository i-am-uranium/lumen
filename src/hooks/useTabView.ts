import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { LogLine } from "@/state/logs";
import type { LogStream } from "@/state/logStream";

const VIEW_CAP = 10_000;

export type SearchOpts = {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  levels: Set<string> | null;
};

export type TabView = {
  lines: LogLine[];
  matches: number[];          // indices into `lines`
  regexError: string | null;
  mergedDropCount: number;     // dropped at merge stage
  totalDropCount: number;      // sum of all stream drops + merged drops
};

/** Quick level detector. Mirrors LogLineRow heuristics; intentionally cheap. */
function detectLevel(text: string): string | null {
  const head = text.slice(0, 200);
  const br = head.match(/\[(trace|debug|info|notice|warn|warning|error|err|fatal|crit|panic)\]/i);
  if (br) {
    return br[1].toLowerCase().replace(/^err$/, "error").replace(/^warning$/, "warn");
  }
  const kv = head.match(/\blevel["']?\s*[:=]\s*["']?(\w+)/i);
  if (kv) {
    const v = kv[1].toLowerCase();
    if (["trace", "debug", "info", "warn", "warning", "error", "err", "fatal"].includes(v)) {
      return v.replace(/^err$/, "error").replace(/^warning$/, "warn");
    }
  }
  return null;
}

/**
 * Pure helper — exported for unit testing without a hook environment.
 *
 * Merges multiple stream buffers by arrivedAt, caps at VIEW_CAP, applies
 * level filter, then runs substring or regex search and returns matching
 * line indices.
 */
export function mergeAndFilter(
  buffers: ReadonlyArray<readonly LogLine[]>,
  opts: SearchOpts,
  perStreamDrops = 0,
): TabView {
  // Concatenate then sort. For tier-1 sizes this is faster than k-way merge.
  let merged: LogLine[] = [];
  for (const b of buffers) merged = merged.concat(b as LogLine[]);
  merged.sort((a, b) => (a.arrivedAt ?? 0) - (b.arrivedAt ?? 0));

  let mergedDropCount = 0;
  if (merged.length > VIEW_CAP) {
    mergedDropCount = merged.length - VIEW_CAP;
    merged = merged.slice(merged.length - VIEW_CAP);
  }

  // Level filter — quick regex on the line head; full parsing lives in LogLineRow.
  // Approximate: covers `[level]`, `level=foo`, JSON-ish forms. Unknown levels
  // are kept (we never hide rows we couldn't classify).
  if (opts.levels) {
    const allowed = opts.levels;
    merged = merged.filter((l) => {
      const lvl = detectLevel(l.text);
      return lvl === null || allowed.has(lvl);
    });
  }

  // Search.
  const matches: number[] = [];
  let regexError: string | null = null;
  if (opts.query) {
    if (opts.regex) {
      try {
        const flags = opts.caseSensitive ? "" : "i";
        const re = new RegExp(opts.query, flags);
        for (let i = 0; i < merged.length; i++) {
          if (re.test(merged[i].text)) matches.push(i);
        }
      } catch (err) {
        regexError = String(err);
      }
    } else {
      if (opts.caseSensitive) {
        for (let i = 0; i < merged.length; i++) {
          if (merged[i].text.includes(opts.query)) matches.push(i);
        }
      } else {
        const q = opts.query.toLowerCase();
        for (let i = 0; i < merged.length; i++) {
          if (merged[i].text.toLowerCase().includes(q)) matches.push(i);
        }
      }
    }
  }

  return {
    lines: merged,
    matches,
    regexError,
    mergedDropCount,
    totalDropCount: mergedDropCount + perStreamDrops,
  };
}

/**
 * React hook: subscribes to all streams in the tab, returns the merged + filtered view.
 * Re-renders only when at least one stream's version changes (via the same
 * useSyncExternalStore pattern as useLogStream).
 */
export function useTabView(streams: LogStream[], opts: SearchOpts): TabView {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const offs = streams.map((s) => s.subscribe(onChange));
      return () => offs.forEach((off) => off());
    },
    [streams],
  );
  // Snapshot is the sum of versions — a primitive that changes whenever any
  // stream notifies. Cheap to compute and stable when nothing changed.
  useSyncExternalStore(
    subscribe,
    () => streams.reduce((sum, s) => sum + s.getVersion(), 0),
  );
  return useMemo(() => {
    const buffers = streams.map((s) => s.getBuffer());
    const drops = streams.reduce((sum, s) => sum + s.getDropCount(), 0);
    return mergeAndFilter(buffers, opts, drops);
  }, [streams, opts.query, opts.regex, opts.caseSensitive, opts.levels]);
}
