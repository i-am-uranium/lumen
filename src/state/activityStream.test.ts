import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityStream, type ActivityEntry } from "./activityStream";

/**
 * The store's start() / stop() invoke Tauri commands and create a real
 * Channel — both unavailable in the vitest jsdom environment. We unit-test
 * the buffer mechanics by reaching into setState directly, which is
 * sufficient: the IPC plumbing is one-line wrappers around well-typed
 * Tauri APIs and not the load-bearing logic.
 */

function entry(overrides: Partial<ActivityEntry> & { id: number }): ActivityEntry {
  // Spread overrides last so caller-supplied fields win — the explicit
  // defaults below are just a typed baseline.
  return {
    receivedAt: 0,
    ts: null,
    kind: "Pod",
    reason: "Created",
    message: "test",
    involved: "default/foo",
    type_: "Normal",
    ...overrides,
  };
}

beforeEach(() => {
  useActivityStream.getState().clear();
  useActivityStream.setState({
    streaming: false,
    streamId: "",
    context: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("activityStream store", () => {
  it("clear() empties entries and resets unread warnings", () => {
    useActivityStream.setState({
      entries: [entry({ id: 1 })],
      unreadWarnings: 3,
    });
    useActivityStream.getState().clear();
    expect(useActivityStream.getState().entries).toEqual([]);
    expect(useActivityStream.getState().unreadWarnings).toBe(0);
  });

  it("markRead() zeroes the unread warnings counter without touching entries", () => {
    const e = entry({ id: 1, type_: "Warning" });
    useActivityStream.setState({ entries: [e], unreadWarnings: 5 });
    useActivityStream.getState().markRead();
    expect(useActivityStream.getState().unreadWarnings).toBe(0);
    expect(useActivityStream.getState().entries).toEqual([e]);
  });

  it("stop() is a no-op when not streaming", async () => {
    await useActivityStream.getState().stop();
    expect(useActivityStream.getState().streaming).toBe(false);
  });
});
