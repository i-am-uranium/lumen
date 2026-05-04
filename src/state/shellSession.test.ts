import { beforeEach, describe, it, expect, vi } from "vitest";
import { ShellSession } from "./shellSession";
import { k8s } from "@/lib/k8s";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((ev: unknown) => void) | null = null;
  },
  invoke: vi.fn(async () => undefined),
}));

vi.mock("@/lib/k8s", () => ({
  k8s: {
    startPodAttach: vi.fn(async () => "fake-session-id"),
    podAttachClose: vi.fn(async () => {}),
    podAttachStdin: vi.fn(async () => {}),
    podAttachResize: vi.fn(async () => {}),
  },
}));

const KEY = {
  pod: "p1",
  namespace: "ns1",
  context: "ctx1",
  container: "app",
  command: ["/bin/sh"],
};

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("ShellSession — buffer + state", () => {
  it("starts in idle state with empty scrollback", () => {
    const s = new ShellSession(KEY);
    expect(s.getState()).toBe("idle");
    expect(s.getScrollbackBytes()).toBe(0);
    expect(s.getExitCode()).toBe(null);
  });

  it("appendOutput accumulates byte chunks", () => {
    const s = new ShellSession(KEY);
    s._appendOutputForTest(bytes("hello "));
    s._appendOutputForTest(bytes("world"));
    expect(s.getScrollbackBytes()).toBe(11);
    const all = s.getScrollbackChunks();
    expect(all.length).toBe(2);
    expect(new TextDecoder().decode(all[0])).toBe("hello ");
  });

  it("scrollback cap evicts oldest bytes when total exceeds 2 MiB", () => {
    const s = new ShellSession(KEY);
    const chunk = new Uint8Array(512 * 1024); // 512 KiB
    chunk.fill(0x41); // ascii 'A'
    for (let i = 0; i < 5; i++) s._appendOutputForTest(chunk);
    // 5 × 512 KiB = 2.5 MiB → cap to 2 MiB by dropping oldest chunk.
    expect(s.getScrollbackBytes()).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(s.getDropCount()).toBeGreaterThan(0);
  });

  it("transitions starting → live on _setLiveForTest", () => {
    const s = new ShellSession(KEY);
    s._setStateForTest("starting");
    expect(s.getState()).toBe("starting");
    s._setStateForTest("live");
    expect(s.getState()).toBe("live");
  });

  it("transitions to exited with exit code", () => {
    const s = new ShellSession(KEY);
    s._setStateForTest("live");
    s._setExitedForTest(0);
    expect(s.getState()).toBe("exited");
    expect(s.getExitCode()).toBe(0);
  });

  it("transitions to failed with error message", () => {
    const s = new ShellSession(KEY);
    s._setFailedForTest("attach refused");
    expect(s.getState()).toBe("failed");
    expect(s.getErrorMessage()).toBe("attach refused");
  });
});

describe("ShellSession — subscribers", () => {
  it("subscribes and receives state-change notifications", () => {
    const s = new ShellSession(KEY);
    let calls = 0;
    s.subscribe(() => calls++);
    s._setStateForTest("starting");
    s._setStateForTest("live");
    expect(calls).toBe(2);
  });

  it("output does NOT notify subscribers", () => {
    const s = new ShellSession(KEY);
    let calls = 0;
    s.subscribe(() => calls++);
    s._appendOutputForTest(bytes("output"));
    expect(calls).toBe(0);
  });

  it("output notifies terminal listeners without a state notification", () => {
    const s = new ShellSession(KEY);
    let stateCalls = 0;
    const chunks: string[] = [];
    s.subscribe(() => stateCalls++);
    s.subscribeOutput((chunk) => chunks.push(new TextDecoder().decode(chunk)));

    s._appendOutputForTest(bytes("fast output"));

    expect(stateCalls).toBe(0);
    expect(chunks).toEqual(["fast output"]);
  });

  it("unsubscribe stops further notifications", () => {
    const s = new ShellSession(KEY);
    let calls = 0;
    const off = s.subscribe(() => calls++);
    s._setStateForTest("starting");
    off();
    s._setStateForTest("live");
    expect(calls).toBe(1);
  });

  it("notifies all subscribers even if one unsubscribes another mid-pass", () => {
    const s = new ShellSession(KEY);
    const calls: string[] = [];
    let offB = () => {};
    s.subscribe(() => {
      calls.push("a");
      offB();
    });
    offB = s.subscribe(() => {
      calls.push("b");
    });
    s._setStateForTest("starting");
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("ShellSession — stdin", () => {
  it("batches rapid terminal input into one backend write", async () => {
    vi.useFakeTimers();
    const s = new ShellSession(KEY);
    await s.start(80, 24);

    await s.sendStdin(bytes("a"));
    await s.sendStdin(bytes("b"));
    await s.sendStdin(bytes("c"));

    expect(k8s.podAttachStdin).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();

    expect(k8s.podAttachStdin).toHaveBeenCalledTimes(1);
    expect(k8s.podAttachStdin).toHaveBeenCalledWith("fake-session-id", [97, 98, 99]);
    vi.useRealTimers();
  });
});

describe("ShellSession — close", () => {
  it("close from live transitions to exited and clears subscribers", () => {
    const s = new ShellSession(KEY);
    s._setStateForTest("live");
    let calls = 0;
    s.subscribe(() => calls++);
    s.close();
    expect(s.getState()).toBe("exited");
    expect(calls).toBe(1); // notify on close
    s._setStateForTest("live"); // attempt to fire again
    expect(calls).toBe(1); // subscribers were cleared
  });

  it("close from idle is a no-op for subscribers but still transitions", () => {
    const s = new ShellSession(KEY);
    s.close();
    expect(s.getState()).toBe("exited");
  });

  it("close is idempotent", () => {
    const s = new ShellSession(KEY);
    s.close();
    s.close();
    expect(s.getState()).toBe("exited");
  });
});

describe("ShellSession — restart", () => {
  it("restart from exited resets scrollback and re-enters live", async () => {
    const s = new ShellSession(KEY);
    s._setStateForTest("live");
    s._appendOutputForTest(bytes("old output\n"));
    s._setExitedForTest(0);
    expect(s.getScrollbackBytes()).toBeGreaterThan(0);

    let calls = 0;
    s.subscribe(() => calls++);

    await s.restart(80, 24);

    expect(s.getState()).toBe("live");
    expect(s.getScrollbackBytes()).toBe(0);
    expect(s.getExitCode()).toBe(null);
    expect(s.getErrorMessage()).toBe(null);
    // notify fired at least: idle reset + starting + live
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("restart from failed resets error and re-attaches", async () => {
    const s = new ShellSession(KEY);
    s._setFailedForTest("boom");
    expect(s.getErrorMessage()).toBe("boom");
    await s.restart(80, 24);
    expect(s.getState()).toBe("live");
    expect(s.getErrorMessage()).toBe(null);
  });

  it("restart while live is a no-op", async () => {
    const s = new ShellSession(KEY);
    s._setStateForTest("live");
    s._appendOutputForTest(bytes("keep me\n"));
    const before = s.getScrollbackBytes();
    await s.restart(80, 24);
    expect(s.getState()).toBe("live");
    expect(s.getScrollbackBytes()).toBe(before);
  });
});
