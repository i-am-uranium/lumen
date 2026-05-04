import { create } from "zustand";

export type LogLine = {
  pod: string;
  container: string;
  text: string;
  /** Monotonic per-stream id; used as React key. Optional for backward compatibility. */
  id?: number;
  /** Wall-clock ms when the line was received in JS. Used for cross-stream merge-sort. */
  arrivedAt?: number;
};

type StreamState = {
  buffer: LogLine[];
  paused: boolean;
  mutedPods: Set<string>;
  colorByPod: Record<string, string>;
};

type Store = {
  streams: Record<string, StreamState>;
  openStream: (id: string) => void;
  closeStream: (id: string) => void;
  appendLine: (id: string, line: LogLine) => void;
  setPaused: (id: string, paused: boolean) => void;
  toggleMute: (id: string, pod: string) => void;
};

const PALETTE = [
  "text-term-green",
  "text-term-amber",
  "text-term-red",
  "text-sky-300",
  "text-fuchsia-300",
  "text-orange-300",
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const CAP = 10_000;

export const useLogsStore = create<Store>((set) => ({
  streams: {},
  openStream: (id) =>
    set((s) => ({
      streams: {
        ...s.streams,
        [id]: { buffer: [], paused: false, mutedPods: new Set(), colorByPod: {} },
      },
    })),
  closeStream: (id) =>
    set((s) => {
      const { [id]: _removed, ...rest } = s.streams;
      return { streams: rest };
    }),
  appendLine: (id, line) =>
    set((s) => {
      const stream = s.streams[id];
      if (!stream) return s;
      const color = stream.colorByPod[line.pod] ?? PALETTE[hash(line.pod) % PALETTE.length];
      const colorByPod = stream.colorByPod[line.pod]
        ? stream.colorByPod
        : { ...stream.colorByPod, [line.pod]: color };
      const buf =
        stream.buffer.length >= CAP
          ? stream.buffer.slice(stream.buffer.length - CAP + 1)
          : stream.buffer.slice();
      buf.push(line);
      return { streams: { ...s.streams, [id]: { ...stream, buffer: buf, colorByPod } } };
    }),
  setPaused: (id, paused) =>
    set((s) =>
      s.streams[id] ? { streams: { ...s.streams, [id]: { ...s.streams[id], paused } } } : s
    ),
  toggleMute: (id, pod) =>
    set((s) => {
      const st = s.streams[id];
      if (!st) return s;
      const next = new Set(st.mutedPods);
      if (next.has(pod)) next.delete(pod);
      else next.add(pod);
      return { streams: { ...s.streams, [id]: { ...st, mutedPods: next } } };
    }),
}));
