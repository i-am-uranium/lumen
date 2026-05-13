import { useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { WatchEvent } from "@/lib/k8s";

// Opens a kube watch via the given Tauri command and invalidates the
// supplied React Query keys on every Apply/Delete event. The watch handles
// kube-rs reconnect/relist internally; transient `error` events just bubble
// to console rather than blowing away the query cache.
//
// Cleanup is via `stop_stream` with the auto-generated `streamId`, mirroring
// the lifecycle used by stream_logs / stream_events.
//
// Memoization: rerunning this hook stops and reopens the watch (which
// triggers a kubelet re-list), so we use `stableHash` over args + queryKeys
// to detect *meaningful* change and ignore identity-only churn from parent
// rerenders. Refs hold the latest callbacks so handlers see fresh values
// without forcing a watch reopen.

type Options<T> = {
  queryKeys: QueryKey[];
  command: "watch_nodes" | "watch_workloads";
  args?: Record<string, unknown>;
  onEvent?: (e: WatchEvent<T>) => void;
  enabled?: boolean;
};

let counter = 0;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

// Deterministic stringify with sorted keys at every depth. Matches the
// values we actually pass (strings/numbers/null/arrays/plain objects) and
// avoids the "key-order changes break memoization" hazard of JSON.stringify
// on objects built across renders.
function stableHash(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableHash).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableHash(v)}`).join(",")}}`;
}

export function useK8sWatch<T>({
  queryKeys,
  command,
  args = {},
  onEvent,
  enabled = true,
}: Options<T>) {
  const qc = useQueryClient();

  // Refs keep the latest values without re-triggering the effect.
  const onEventRef = useRef(onEvent);
  const queryKeysRef = useRef(queryKeys);
  onEventRef.current = onEvent;
  queryKeysRef.current = queryKeys;

  const argsHash = stableHash(args);
  const keysHash = stableHash(queryKeys);

  useEffect(() => {
    if (!enabled) return;
    const streamId = nextId(command);
    let ch: Channel<WatchEvent<T>>;
    try {
      ch = new Channel<WatchEvent<T>>();
    } catch (err) {
      console.warn(`watch ${command} unavailable`, err);
      return;
    }

    let cancelled = false;
    // Coalesce bursts of Apply/Delete events into a single invalidation pass.
    // A churning cluster fires dozens of events per second; without debouncing
    // each one triggers a full refetch of every watched query key, which on
    // probe_one_inner means 10 parallel kube list calls per refresh.
    let pendingInvalidate = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (cancelled || !pendingInvalidate) return;
      pendingInvalidate = false;
      for (const key of queryKeysRef.current) {
        qc.invalidateQueries({ queryKey: key });
      }
    };
    const scheduleInvalidate = () => {
      pendingInvalidate = true;
      if (timer !== null) return;
      timer = setTimeout(flush, 400);
    };

    ch.onmessage = (e) => {
      if (cancelled) return;
      onEventRef.current?.(e);
      if (e.kind === "applied" || e.kind === "deleted") {
        scheduleInvalidate();
      }
    };

    invoke(command, { ...args, streamId, channel: ch }).catch((err) => {
      console.warn(`watch ${command} failed`, err);
    });

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      invoke("stop_stream", { streamId }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, command, argsHash, keysHash]);
}
