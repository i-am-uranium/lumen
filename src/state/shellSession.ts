import { Channel } from "@tauri-apps/api/core";
import { k8s, type AttachEvent } from "@/lib/k8s";

export type ShellState = "idle" | "starting" | "live" | "exited" | "failed";

export type ShellSessionKey = {
  pod: string;
  namespace: string;
  context: string;
  container: string;
  command: string[];
};

const SCROLLBACK_CAP_BYTES = 2 * 1024 * 1024; // 2 MiB
const STDIN_FLUSH_DELAY_MS = 8;

type Subscriber = () => void;
type OutputSubscriber = (chunk: Uint8Array) => void;

/**
 * Owns one shell attach lifecycle. Holds raw byte scrollback (capped) so
 * inactive tabs can dispose their xterm and still have output to replay
 * when reactivated. Tauri lifecycle (start/stop/sendStdin/resize) lands
 * in Task 1.4.
 */
export class ShellSession {
  readonly pod: string;
  readonly namespace: string;
  readonly context: string;
  readonly container: string;
  readonly command: ReadonlyArray<string>;

  private state: ShellState = "idle";
  private scrollback: Uint8Array[] = [];
  private scrollbackBytes = 0;
  private dropCount = 0;
  private exitCode: number | null = null;
  private errorMessage: string | null = null;
  private sessionId: string | null = null;
  private subscribers = new Set<Subscriber>();
  private outputSubscribers = new Set<OutputSubscriber>();
  private stdinQueue: number[] = [];
  private stdinFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic counter that increments every time subscribers are notified.
   *  Used by useSyncExternalStore as a primitive snapshot. */
  private version = 0;

  constructor(key: ShellSessionKey) {
    this.pod = key.pod;
    this.namespace = key.namespace;
    this.context = key.context;
    this.container = key.container;
    this.command = [...key.command];
  }

  getState(): ShellState {
    return this.state;
  }

  getScrollbackChunks(): ReadonlyArray<Uint8Array> {
    return this.scrollback;
  }

  getScrollbackBytes(): number {
    return this.scrollbackBytes;
  }

  getDropCount(): number {
    return this.dropCount;
  }

  getExitCode(): number | null {
    return this.exitCode;
  }

  getErrorMessage(): string | null {
    return this.errorMessage;
  }

  getVersion(): number {
    return this.version;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  subscribeOutput(fn: OutputSubscriber): () => void {
    this.outputSubscribers.add(fn);
    return () => {
      this.outputSubscribers.delete(fn);
    };
  }

  close(): void {
    if (this.state === "exited") return;
    this.clearPendingStdin();
    const id = this.sessionId;
    this.sessionId = null;
    this.state = "exited";
    this.notify();
    this.subscribers.clear();
    if (id) void k8s.podAttachClose(id).catch(() => {});
  }

  /**
   * Relaunch the same command after the session has exited or failed.
   * No-op while a session is live or starting. Resets scrollback, drop
   * count, exit/error fields, and notifies subscribers before delegating
   * to start().
   */
  async restart(cols: number, rows: number): Promise<void> {
    if (this.state === "live" || this.state === "starting") return;
    this.scrollback = [];
    this.scrollbackBytes = 0;
    this.dropCount = 0;
    this.exitCode = null;
    this.errorMessage = null;
    this.sessionId = null;
    this.state = "idle";
    this.notify();
    await this.start(cols, rows);
  }

  /**
   * Initiate the Tauri attach. Idempotent — calling twice on a live
   * session is a no-op. The promise resolves when the backend has
   * confirmed the attach (or rejects on failure).
   *
   * @param cols Terminal columns at attach time.
   * @param rows Terminal rows at attach time.
   */
  async start(cols: number, rows: number): Promise<void> {
    if (this.state === "starting" || this.state === "live") return;
    this.state = "starting";
    this.errorMessage = null;
    this.exitCode = null;
    this.notify();

    const channel = new Channel<AttachEvent>();
    channel.onmessage = (ev) => this.handleAttachEvent(ev);

    try {
      const id = await k8s.startPodAttach(
        {
          namespace: this.namespace,
          pod: this.pod,
          container: this.container,
          command: [...this.command],
          tty: true,
          cols,
          rows,
        },
        channel,
        this.context || undefined,
      );
      // If close() ran during the in-flight attach, this.state is no
      // longer "starting"; clean up the backend session we just opened
      // so it isn't leaked.
      if (this.state === "starting") {
        this.sessionId = id;
        this.state = "live";
        this.notify();
      } else {
        void k8s.podAttachClose(id).catch(() => {});
      }
    } catch (err) {
      this.state = "failed";
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.notify();
    }
  }

  /**
   * Send keystrokes to the live session. No-op if not live.
   */
  async sendStdin(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return;
    this.stdinQueue.push(...bytes);
    if (this.stdinFlushTimer) return;
    this.stdinFlushTimer = setTimeout(() => {
      this.stdinFlushTimer = null;
      void this.flushStdin();
    }, STDIN_FLUSH_DELAY_MS);
  }

  /**
   * Tell the backend the terminal was resized. No-op if not live.
   */
  async resize(cols: number, rows: number): Promise<void> {
    const id = this.sessionId;
    if (!id || this.state !== "live") return;
    await k8s.podAttachResize(id, cols, rows).catch(() => {});
  }

  private handleAttachEvent(ev: AttachEvent): void {
    if (ev.kind === "stdout" || ev.kind === "stderr") {
      this.appendOutput(new TextEncoder().encode(ev.text));
      // No notify — output writes go to xterm directly in Phase 2.
    } else if (ev.kind === "closed") {
      this.exitCode = ev.exit_code;
      if (ev.exit_code === null && ev.message) {
        this.state = "failed";
        this.errorMessage = ev.message;
      } else {
        this.state = "exited";
      }
      this.sessionId = null;
      this.notify();
    }
  }

  protected notify(): void {
    this.version++;
    for (const fn of [...this.subscribers]) fn();
  }

  /** @internal */
  _appendOutputForTest(chunk: Uint8Array): void {
    this.appendOutput(chunk);
  }

  /** @internal */
  _setStateForTest(state: ShellState): void {
    this.state = state;
    this.notify();
  }

  /** @internal */
  _setExitedForTest(code: number | null): void {
    this.state = "exited";
    this.exitCode = code;
    this.notify();
  }

  /** @internal */
  _setFailedForTest(message: string): void {
    this.state = "failed";
    this.errorMessage = message;
    this.notify();
  }

  /**
   * Production path: append a byte chunk from the attach channel. Cap to
   * 2 MiB by dropping oldest chunks whole.
   */
  protected appendOutput(chunk: Uint8Array): void {
    this.scrollback.push(chunk);
    this.scrollbackBytes += chunk.byteLength;
    while (this.scrollbackBytes > SCROLLBACK_CAP_BYTES && this.scrollback.length > 1) {
      const dropped = this.scrollback.shift()!;
      this.scrollbackBytes -= dropped.byteLength;
      this.dropCount += dropped.byteLength;
    }
    for (const fn of [...this.outputSubscribers]) fn(chunk);
  }

  private async flushStdin(): Promise<void> {
    const id = this.sessionId;
    if (!id || this.state !== "live" || this.stdinQueue.length === 0) {
      this.stdinQueue = [];
      return;
    }
    const bytes = this.stdinQueue;
    this.stdinQueue = [];
    await k8s.podAttachStdin(id, bytes).catch(() => {
      // Keystroke failures are silenced; the channel close event surfaces
      // session-level breakage.
    });
  }

  private clearPendingStdin(): void {
    if (this.stdinFlushTimer) {
      clearTimeout(this.stdinFlushTimer);
      this.stdinFlushTimer = null;
    }
    this.stdinQueue = [];
  }
}
