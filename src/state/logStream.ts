import { Channel, invoke } from "@tauri-apps/api/core";
import type { LogLine } from "./logs";

export type LogStreamStatus = "connecting" | "live" | "retrying" | "ended" | "error";
export type LogStreamEvent = { type: "status"; pod: string; status: LogStreamStatus; message?: string | null } | Omit<LogLine, "id" | "arrivedAt">;

export function logErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}

export type LogStreamKey = { pod: string; container: string };

const BUFFER_CAP = 10_000;
const TRIM_CHUNK = 1_000;
const PENDING_CAP = 10_000; // matches buffer cap so paused streams don't grow unbounded

type Subscriber = () => void;

export class LogStream {
  // Identity (set in constructor) — readonly because they identify the stream.
  readonly pod: string;
  readonly container: string;

  // Tauri selector params — copied from constructor key, mutable so a stop()
  // followed by a re-start() can pick up new values if the consumer wants.
  context?: string;
  namespace = "";
  sinceSeconds: number | null = 600;
  tailLines: number | null = 500;
  /** When true, request the previous terminated container's logs (kubectl --previous). */
  previous = false;

  // Ring-buffer + drop accounting.
  private buffer: LogLine[] = [];
  private pending: LogLine[] = [];
  private nextId = 0;
  private dropCount = 0;

  // Subscribers + RAF coalescing.
  private subscribers = new Set<Subscriber>();
  private rafHandle: number | null = null;

  // Lifecycle state.
  private paused = false;
  private streamId: string | null = null;
  errorMessage: string | null = null;
  status: LogStreamStatus = "ended";

  /** Monotonic counter that increments every time subscribers are notified.
   *  Used by useSyncExternalStore as a primitive snapshot. */
  private version = 0;

  constructor(key: LogStreamKey & {
    namespace?: string;
    context?: string;
    sinceSeconds?: number | null;
    tailLines?: number | null;
    previous?: boolean;
  }) {
    this.pod = key.pod;
    this.container = key.container;
    this.namespace = key.namespace ?? "";
    this.context = key.context;
    if (key.sinceSeconds !== undefined) this.sinceSeconds = key.sinceSeconds;
    if (key.tailLines !== undefined) this.tailLines = key.tailLines;
    if (key.previous !== undefined) this.previous = key.previous;
  }

  /**
   * Test-only synchronous append, bypasses pending queue.
   * @internal
   */
  _appendForTest(line: Omit<LogLine, "id" | "arrivedAt">): void {
    this.appendOne({ ...line, id: this.nextId++, arrivedAt: Date.now() });
  }

  /**
   * Test-only enqueue into pending.
   * @internal
   */
  _enqueueForTest(line: Omit<LogLine, "id" | "arrivedAt">): void {
    this.enqueue(line);
  }

  /**
   * Test-only synchronous flush of pending.
   * @internal
   */
  _flushForTest(): void {
    this.flush();
  }

  /** Production path: called by Tauri channel handler. */
  enqueue(line: Omit<LogLine, "id" | "arrivedAt">): void {
    this.pending.push({ ...line, id: this.nextId++, arrivedAt: Date.now() });
    if (this.pending.length > PENDING_CAP) {
      const trim = this.pending.length - PENDING_CAP;
      this.pending.splice(0, trim);
      this.dropCount += trim;
    }
    this.scheduleFlush();
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.notify();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.flush();
    this.notify();
  }

  isPaused(): boolean {
    return this.paused;
  }

  clear(): void {
    if (this.buffer.length === 0) return;
    this.buffer = [];
    this.notify();
  }

  private notify(): void {
    this.version++;
    for (const fn of [...this.subscribers]) fn();
  }

  /** Start the Tauri stream. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.streamId !== null) return;
    const id = `logstream-${this.pod}-${this.container}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.streamId = id;
    this.errorMessage = null;
    this.status = "connecting";
    this.notify();
    const channel = new Channel<LogStreamEvent>();
    channel.onmessage = (msg) => {
      if (this.streamId !== id) return;
      if ("type" in msg && msg.type === "status") {
        this.status = msg.status;
        this.errorMessage = msg.status === "error" || msg.status === "retrying" ? msg.message ?? null : null;
        if (msg.status === "ended" || msg.status === "error") this.streamId = null;
        this.notify();
      } else if ("text" in msg) {
        this.enqueue(msg);
      }
    };
    invoke("stream_logs", {
      selector: {
        namespace: this.namespace,
        label_selector: null,
        pod_name: this.pod,
        container: this.container,
        since_seconds: this.sinceSeconds,
        tail_lines: this.tailLines,
        previous: this.previous,
      },
      streamId: id,
      channel,
      context: this.context || undefined,
    }).then(() => {
      // stop() may race command registration. Once startup is acknowledged,
      // cancel a stale attempt again so it cannot leave an orphaned reader.
      if (this.streamId !== id) invoke("stop_stream", { streamId: id }).catch(() => {});
    }).catch((err) => {
      if (this.streamId !== id) return;
      this.streamId = null;
      this.status = "error";
      this.errorMessage = logErrorMessage(err);
      this.notify();
    });
  }

  /** Stop the Tauri stream and cancel any pending RAF flush. */
  stop(): void {
    if (this.streamId !== null) {
      invoke("stop_stream", { streamId: this.streamId }).catch(() => {});
      this.streamId = null;
    }
    if (this.rafHandle !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.status = "ended";
    this.notify();
  }

  isRunning(): boolean {
    return this.streamId !== null;
  }

  getBuffer(): readonly LogLine[] {
    return this.buffer;
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  getDropCount(): number {
    return this.dropCount;
  }

  getVersion(): number {
    return this.version;
  }

  private scheduleFlush(): void {
    if (this.rafHandle !== null) return;
    if (typeof requestAnimationFrame === "undefined") {
      // Test environments without RAF: caller must call _flushForTest.
      return;
    }
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      this.flush();
    });
  }

  private flush(): void {
    if (this.paused) return;
    if (this.pending.length === 0) return;
    for (const line of this.pending) this.appendOne(line);
    this.pending = [];
    this.notify();
  }

  private appendOne(line: LogLine): void {
    this.buffer.push(line);
    if (this.buffer.length > BUFFER_CAP) {
      this.buffer.splice(0, TRIM_CHUNK);
      this.dropCount += TRIM_CHUNK;
    }
  }
}

/** Capture a bounded log sample, rejecting failed streams instead of exporting an empty file. */
export async function captureLogSnapshot({ namespace, pod, context, previous = false }: {
  namespace: string;
  pod: string;
  context?: string;
  previous?: boolean;
}): Promise<string[]> {
  const streamId = `download-${crypto.randomUUID()}`;
  const channel = new Channel<LogStreamEvent>();
  const lines: string[] = [];
  let error: string | null = null;
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  channel.onmessage = (event) => {
    if ("text" in event) {
      lines.push(event.text);
    } else if (event.status === "error" || event.status === "retrying") {
      error = event.message ?? "Log download was interrupted";
      finish();
    } else if (event.status === "ended") {
      finish();
    }
  };
  try {
    await invoke("stream_logs", {
      selector: { namespace, pod_name: pod, label_selector: null, container: null, since_seconds: null, tail_lines: 5000, previous },
      streamId, channel, context: context || undefined,
    });
    await Promise.race([completed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await invoke("stop_stream", { streamId }).catch(() => {});
  }
  if (error) throw new Error(error);
  return lines;
}
