import { create } from "zustand";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { EventLine } from "@/lib/k8s";

/**
 * Cluster-wide activity stream
 * ────────────────────────────
 *
 * Subscribes to the existing `stream_events` Tauri command (no namespace
 * filter — we want everything) and accumulates the last N events into a
 * ring buffer. The activity drawer renders the buffer and a "since you
 * last opened" Warning count drives the badge on the topbar Bell button.
 *
 * One stream per (context, namespace=null) pair. Switching context tears
 * down the previous stream before opening a new one — events are scoped
 * to a single cluster.
 */

export type ActivityEntry = EventLine & {
  /** Monotonic id for React keys; events from the API don't carry one. */
  id: number;
  /** Wall-clock ms when the JS side received the event. */
  receivedAt: number;
};

const CAP = 250;

type Store = {
  /** Newest-first list of events, capped at CAP. */
  entries: ActivityEntry[];
  /**
   * Count of Warning-tier events since the user last marked the drawer as
   * read. Drives the topbar badge. Cleared by markRead().
   */
  unreadWarnings: number;
  /** True while a stream is open. */
  streaming: boolean;
  /** Stream id used to stop the backend stream — empty when not streaming. */
  streamId: string;
  /** Last context the stream was started for, for re-open / resume. */
  context: string | null;

  start: (context: string) => Promise<void>;
  stop: () => Promise<void>;
  /** Reset the unread Warning count. Called when the drawer opens. */
  markRead: () => void;
  /** Wipe entries — primarily for tests. */
  clear: () => void;
};

let _idCounter = 0;
function nextId(): number {
  _idCounter += 1;
  return _idCounter;
}

export const useActivityStream = create<Store>((set, get) => ({
  entries: [],
  unreadWarnings: 0,
  streaming: false,
  streamId: "",
  context: null,

  start: async (context: string) => {
    const current = get();
    // Same context already streaming? Idempotent — no-op so consumers can
    // call start() on every render without churning the backend.
    if (current.streaming && current.context === context) return;
    if (current.streaming) await current.stop();

    const channel = new Channel<EventLine>();
    channel.onmessage = (line) => {
      set((s) => {
        const entry: ActivityEntry = { ...line, id: nextId(), receivedAt: Date.now() };
        const next = [entry, ...s.entries];
        // Trim from the tail — newest-first ordering means oldest are at end.
        if (next.length > CAP) next.length = CAP;
        const isWarning = (line.type_ ?? "").toLowerCase() === "warning";
        return {
          entries: next,
          unreadWarnings: s.unreadWarnings + (isWarning ? 1 : 0),
        };
      });
    };
    const streamId = `activity-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    set({ streaming: true, streamId, context, entries: [], unreadWarnings: 0 });
    try {
      await invoke<void>("stream_events", {
        namespace: null,
        streamId,
        channel,
        context,
      });
    } catch (err) {
      // Backend rejected the subscription — flip the flag so a retry next
      // tick is possible, but don't blow up the caller.
      set({ streaming: false, streamId: "", context: null });
      // eslint-disable-next-line no-console
      console.warn("activity stream failed to start:", err);
    }
  },

  stop: async () => {
    const { streamId, streaming } = get();
    if (!streaming || !streamId) return;
    set({ streaming: false, streamId: "", context: null });
    try {
      await invoke<void>("stop_stream", { streamId });
    } catch {
      // Best-effort. If the backend is already gone the stream goes with it.
    }
  },

  markRead: () => set({ unreadWarnings: 0 }),
  clear: () => set({ entries: [], unreadWarnings: 0 }),
}));
