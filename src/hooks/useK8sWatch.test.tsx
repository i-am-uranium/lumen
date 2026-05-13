import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useK8sWatch } from "./useK8sWatch";

// Hold the latest registered onmessage so tests can inject events.
let lastChannelHandler: ((e: unknown) => void) | null = null;
let shouldThrowChannel = false;

vi.mock("@tauri-apps/api/core", () => {
  return {
    invoke: vi.fn(() => Promise.resolve()),
    Channel: class FakeChannel {
      _h: ((e: unknown) => void) | null = null;
      constructor() {
        if (shouldThrowChannel) {
          throw new TypeError("Cannot read properties of undefined (reading 'transformCallback')");
        }
      }
      get onmessage() {
        return this._h ?? (() => {});
      }
      set onmessage(h: (e: unknown) => void) {
        this._h = h;
        lastChannelHandler = h;
      }
    },
  };
});

import { invoke } from "@tauri-apps/api/core";

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

describe("useK8sWatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastChannelHandler = null;
    shouldThrowChannel = false;
  });

  it("invokes the watch command with the merged args + auto streamId on mount", () => {
    const { wrapper } = wrap();
    renderHook(
      () =>
        useK8sWatch({
          queryKeys: [["k8s", "nodes", "ctx-a"]],
          command: "watch_nodes",
          args: { context: "ctx-a" },
        }),
      { wrapper },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, payload] = (invoke as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(cmd).toBe("watch_nodes");
    expect(payload).toMatchObject({ context: "ctx-a" });
    expect(payload).toHaveProperty("streamId");
    expect(payload).toHaveProperty("channel");
  });

  it("invalidates the supplied query keys on Apply events (debounced)", async () => {
    vi.useFakeTimers();
    try {
      const { qc, wrapper } = wrap();
      const spy = vi.spyOn(qc, "invalidateQueries");
      renderHook(
        () =>
          useK8sWatch({
            queryKeys: [["k8s", "nodes", "ctx"]],
            command: "watch_nodes",
          }),
        { wrapper },
      );
      expect(lastChannelHandler).not.toBeNull();
      act(() => {
        lastChannelHandler!({ kind: "applied", item: { name: "n1" } });
      });
      // Debounce delays the invalidate; nothing should fire before the timer.
      expect(spy).not.toHaveBeenCalled();
      act(() => {
        vi.runAllTimers();
      });
      expect(spy).toHaveBeenCalledWith({ queryKey: ["k8s", "nodes", "ctx"] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a burst of events into a single invalidate per key", async () => {
    vi.useFakeTimers();
    try {
      const { qc, wrapper } = wrap();
      const spy = vi.spyOn(qc, "invalidateQueries");
      renderHook(
        () =>
          useK8sWatch({
            queryKeys: [["k8s", "nodes", "ctx"]],
            command: "watch_nodes",
          }),
        { wrapper },
      );
      act(() => {
        for (let i = 0; i < 25; i++) {
          lastChannelHandler!({ kind: "applied", item: { name: `n${i}` } });
        }
        lastChannelHandler!({ kind: "deleted", item: { name: "old" } });
      });
      act(() => {
        vi.runAllTimers();
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores transient error events (no invalidate)", () => {
    const { qc, wrapper } = wrap();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderHook(
      () =>
        useK8sWatch({
          queryKeys: [["k8s", "nodes"]],
          command: "watch_nodes",
        }),
      { wrapper },
    );
    act(() => {
      lastChannelHandler!({ kind: "error", message: "stream hiccup" });
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not crash the pane when the Tauri channel bridge is unavailable", () => {
    shouldThrowChannel = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { wrapper } = wrap();
      expect(() =>
        renderHook(
          () =>
            useK8sWatch({
              queryKeys: [["k8s", "nodes"]],
              command: "watch_nodes",
            }),
          { wrapper },
        ),
      ).not.toThrow();
      expect(invoke).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "watch watch_nodes unavailable",
        expect.any(TypeError),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("calls stop_stream on unmount", () => {
    const { wrapper } = wrap();
    const { unmount } = renderHook(
      () =>
        useK8sWatch({
          queryKeys: [["k8s", "nodes"]],
          command: "watch_nodes",
        }),
      { wrapper },
    );
    (invoke as unknown as ReturnType<typeof vi.fn>).mockClear();
    unmount();
    expect(invoke).toHaveBeenCalledWith("stop_stream", expect.any(Object));
  });

  it("does not reopen the watch when the args reference changes but values are stable", () => {
    const { wrapper } = wrap();
    const { rerender } = renderHook(
      ({ ctx }: { ctx: string }) =>
        useK8sWatch({
          queryKeys: [["k8s", "nodes", ctx]],
          command: "watch_nodes",
          args: { context: ctx },
        }),
      { wrapper, initialProps: { ctx: "ctx-a" } },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    rerender({ ctx: "ctx-a" });
    // Same value → no reopen, no extra invoke beyond the initial watch.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("reopens the watch when args change to a different value", () => {
    const { wrapper } = wrap();
    const { rerender } = renderHook(
      ({ ctx }: { ctx: string }) =>
        useK8sWatch({
          queryKeys: [["k8s", "nodes", ctx]],
          command: "watch_nodes",
          args: { context: ctx },
        }),
      { wrapper, initialProps: { ctx: "ctx-a" } },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    rerender({ ctx: "ctx-b" });
    // close (stop_stream) + reopen (watch_nodes) = 2 more calls.
    expect(invoke).toHaveBeenCalledTimes(3);
    const cmds = (invoke as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      ([c]) => c,
    );
    expect(cmds).toEqual(["watch_nodes", "stop_stream", "watch_nodes"]);
  });
});
