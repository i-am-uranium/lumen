import { describe, it, expect, vi } from "vitest";
import { LogStream } from "./logStream";

vi.mock("@tauri-apps/api/core", () => {
  return {
    Channel: class {
      onmessage?: (msg: unknown) => void;
    },
    invoke: vi.fn().mockResolvedValue(undefined),
  };
});

describe("LogStream — buffer", () => {
  it("appends lines and assigns monotonic ids", () => {
    const s = new LogStream({ pod: "api-1", container: "app" });
    s._appendForTest({ pod: "api-1", container: "app", text: "a" });
    s._appendForTest({ pod: "api-1", container: "app", text: "b" });
    const buf = s.getBuffer();
    expect(buf).toHaveLength(2);
    expect(buf[0].id).toBe(0);
    expect(buf[1].id).toBe(1);
    expect(buf[0].arrivedAt).toBeGreaterThan(0);
  });

  it("caps buffer at 10_000 and trims oldest 10% on overflow", () => {
    const s = new LogStream({ pod: "api-1", container: "app" });
    for (let i = 0; i < 10_500; i++) {
      s._appendForTest({ pod: "api-1", container: "app", text: `line ${i}` });
    }
    const buf = s.getBuffer();
    // After overflow at 10_000, trim 1_000 → buffer length goes to 9_000,
    // then continues appending up to 10_500 - the trim point.
    // First trim happens at index 10_000: trims to 9_000. Then 10_001..10_499 = 500 more → 9_500.
    expect(buf.length).toBeLessThanOrEqual(10_000);
    expect(buf.length).toBeGreaterThanOrEqual(9_000);
    // Oldest line dropped; last line preserved
    expect(buf[buf.length - 1].text).toBe("line 10499");
    expect(s.getDropCount()).toBeGreaterThanOrEqual(1_000);
  });
});

describe("LogStream — coalescing", () => {
  it("buffers events into pending and flushes on tick", () => {
    const s = new LogStream({ pod: "api-1", container: "app" });
    s._enqueueForTest({ pod: "api-1", container: "app", text: "a" });
    s._enqueueForTest({ pod: "api-1", container: "app", text: "b" });
    expect(s.getBuffer()).toHaveLength(0);
    expect(s.getPendingCount()).toBe(2);
    s._flushForTest();
    expect(s.getBuffer()).toHaveLength(2);
    expect(s.getPendingCount()).toBe(0);
  });

  it("notifies subscribers once per flush", () => {
    const s = new LogStream({ pod: "api-1", container: "app" });
    let calls = 0;
    s.subscribe(() => calls++);
    s._enqueueForTest({ pod: "api-1", container: "app", text: "a" });
    s._enqueueForTest({ pod: "api-1", container: "app", text: "b" });
    s._flushForTest();
    expect(calls).toBe(1);
  });

  it("unsubscribe stops further notifications", () => {
    const s = new LogStream({ pod: "api-1", container: "app" });
    let calls = 0;
    const off = s.subscribe(() => calls++);
    s._enqueueForTest({ pod: "api-1", container: "app", text: "a" });
    s._flushForTest();
    off();
    s._enqueueForTest({ pod: "api-1", container: "app", text: "b" });
    s._flushForTest();
    expect(calls).toBe(1);
  });

  it("notifies all subscribers even if one unsubscribes another mid-pass", () => {
    const s = new LogStream({ pod: "api-1", container: "app" });
    const calls: string[] = [];
    let offB = () => {};
    s.subscribe(() => {
      calls.push("a");
      offB();
    });
    offB = s.subscribe(() => {
      calls.push("b");
    });
    s._enqueueForTest({ pod: "api-1", container: "app", text: "x" });
    s._flushForTest();
    // Both A and B fire on this flush. (B is unsubscribed by A, but the snapshot
    // taken at flush start still includes B.)
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("LogStream — pause/clear", () => {
  it("paused flush is a no-op until resumed", () => {
    const s = new LogStream({ pod: "api-1", container: "app" });
    s.pause();
    s._enqueueForTest({ pod: "api-1", container: "app", text: "a" });
    s._flushForTest();
    expect(s.getBuffer()).toHaveLength(0);
    expect(s.getPendingCount()).toBe(1);
    s.resume();
    expect(s.getBuffer()).toHaveLength(1);
    expect(s.getPendingCount()).toBe(0);
  });

  it("paused state never grows pending unbounded", () => {
    const s = new LogStream({ pod: "api-1", container: "app" });
    s.pause();
    for (let i = 0; i < 11_000; i++) {
      s._enqueueForTest({ pod: "api-1", container: "app", text: `${i}` });
    }
    expect(s.getPendingCount()).toBeLessThanOrEqual(10_000);
    expect(s.getDropCount()).toBeGreaterThanOrEqual(1_000);
  });

  it("clear empties buffer but does not stop stream", () => {
    const s = new LogStream({ pod: "api-1", container: "app" });
    s._enqueueForTest({ pod: "api-1", container: "app", text: "a" });
    s._flushForTest();
    s.clear();
    expect(s.getBuffer()).toHaveLength(0);
    s._enqueueForTest({ pod: "api-1", container: "app", text: "b" });
    s._flushForTest();
    expect(s.getBuffer()).toHaveLength(1);
    expect(s.getBuffer()[0].text).toBe("b");
  });

  it("forwards previous=true to stream_logs so the kubelet returns the prior container slice", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
    const s = new LogStream({
      pod: "api-1",
      container: "app",
      namespace: "prod",
      previous: true,
    });
    s.start();
    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = vi.mocked(invoke).mock.calls[0] as [
      string,
      { selector: { previous: boolean } },
    ];
    expect(cmd).toBe("stream_logs");
    expect(args.selector.previous).toBe(true);
    s.stop();
  });

  it("defaults previous=false when the consumer doesn't specify", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
    const s = new LogStream({ pod: "api-1", container: "app" });
    s.start();
    const [, args] = vi.mocked(invoke).mock.calls[0] as [
      string,
      { selector: { previous: boolean } },
    ];
    expect(args.selector.previous).toBe(false);
    s.stop();
  });

  it("isPaused reflects state and notifies subscribers on toggle", () => {
    const s = new LogStream({ pod: "api-1", container: "app" });
    let calls = 0;
    s.subscribe(() => calls++);
    expect(s.isPaused()).toBe(false);
    s.pause();
    expect(s.isPaused()).toBe(true);
    s.resume();
    expect(s.isPaused()).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("LogStream — lifecycle", () => {
  async function start() {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockClear();
    const stream = new LogStream({ pod: "api", container: "app" });
    stream.start();
    const args = vi.mocked(invoke).mock.calls[0][1] as { channel: { onmessage: (event: unknown) => void } };
    return { stream, send: args.channel.onmessage };
  }

  it("reports connecting until the backend confirms live, then retrying and ended", async () => {
    const { stream, send } = await start();
    expect(stream.status).toBe("connecting");
    send({ type: "status", pod: "api", status: "live" });
    expect(stream.status).toBe("live");
    send({ type: "status", pod: "api", status: "retrying", message: "connection lost" });
    expect(stream.status).toBe("retrying");
    expect(stream.getPendingCount()).toBe(0);
    send({ type: "status", pod: "", status: "ended" });
    expect(stream.status).toBe("ended");
    expect(stream.isRunning()).toBe(false);
  });

  it("ignores late messages and startup failures from a stopped attempt", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    let reject!: (error: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const { stream, send } = await start();
    stream.stop();
    stream.start();
    send({ pod: "api", container: "app", text: "stale" });
    reject({ message: "old request failed" });
    await Promise.resolve();
    expect(stream.getPendingCount()).toBe(0);
    expect(stream.errorMessage).toBeNull();
    expect(stream.status).toBe("connecting");
    stream.stop();
  });

  it("surfaces structured startup errors and allows starting again", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockRejectedValueOnce({ kind: "K8s", message: "access denied" });
    const { stream } = await start();
    await Promise.resolve();
    expect(stream.errorMessage).toBe("access denied");
    expect(stream.status).toBe("error");
    expect(stream.isRunning()).toBe(false);
    stream.start();
    expect(stream.errorMessage).toBeNull();
    expect(stream.status).toBe("connecting");
    stream.stop();
  });
  it("cancels again after a stopped startup is acknowledged", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    let acknowledge!: () => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const { stream } = await start();
    stream.stop();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "stop_stream")).toHaveLength(1);
    acknowledge();
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "stop_stream")).toHaveLength(2);
  });

});
