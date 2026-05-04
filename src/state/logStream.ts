import { Channel, invoke } from "@tauri-apps/api/core";
import type { LogLine } from "./logs";

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

  /** Monotonic counter that increments every time subscribers are notified.
   *  Used by useSyncExternalStore as a primitive snapshot. */
  private version = 0;

  constructor(key: LogStreamKey & {
    namespace?: string;
    context?: string;
    sinceSeconds?: number | null;
    tailLines?: number | null;
  }) {
    this.pod = key.pod;
    this.container = key.container;
    this.namespace = key.namespace ?? "";
    this.context = key.context;
    if (key.sinceSeconds !== undefined) this.sinceSeconds = key.sinceSeconds;
    if (key.tailLines !== undefined) this.tailLines = key.tailLines;
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
    const channel = new Channel<{ pod: string; container: string; text: string }>();
    channel.onmessage = (msg) => this.enqueue(msg);
    invoke("stream_logs", {
      selector: {
        namespace: this.namespace,
        label_selector: null,
        pod_name: this.pod,
        container: this.container,
        since_seconds: this.sinceSeconds,
        tail_lines: this.tailLines,
      },
      streamId: id,
      channel,
      context: this.context || undefined,
    }).catch((err) => {
      this.errorMessage = String(err);
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
    this.subscribers.clear();
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
