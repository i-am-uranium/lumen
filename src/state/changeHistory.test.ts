import { beforeEach, describe, expect, it } from "vitest";
import {
  CHANGE_HISTORY_RETENTION_LIMIT,
  CHANGE_HISTORY_STORAGE_KEY,
  useChangeHistoryStore,
} from "./changeHistory";

beforeEach(() => {
  window.localStorage.clear();
  useChangeHistoryStore.getState().clearEvents();
});

describe("changeHistory store", () => {
  it("records successful and failed events newest-first and persists them", () => {
    const success = useChangeHistoryStore.getState().recordEvent(
      {
        action: "restart",
        target: {
          kind: "deployment",
          namespace: "payments",
          name: "api",
          context: "dev",
        },
        status: "success",
        summary: "restarted deployment/api",
      },
      100,
      () => "ch-success",
    );

    const failure = useChangeHistoryStore.getState().recordEvent(
      {
        action: "delete",
        target: {
          kind: "pod",
          namespace: "payments",
          name: "api-0",
          context: "dev",
        },
        status: "failure",
        summary: "failed to delete pod/api-0",
        error: "forbidden",
      },
      200,
      () => "ch-failure",
    );

    expect(useChangeHistoryStore.getState().events.map((event) => event.id)).toEqual([
      failure.id,
      success.id,
    ]);
    expect(JSON.parse(window.localStorage.getItem(CHANGE_HISTORY_STORAGE_KEY) ?? "[]")).toHaveLength(2);
    expect(useChangeHistoryStore.getState().events[0]).toMatchObject({
      status: "failure",
      error: "forbidden",
    });
  });

  it("bounds retention to the configured local history limit", () => {
    for (let i = 0; i < CHANGE_HISTORY_RETENTION_LIMIT + 5; i += 1) {
      useChangeHistoryStore.getState().recordEvent(
        {
          action: "scale",
          target: {
            kind: "deployment",
            namespace: "default",
            name: `api-${i}`,
            context: "dev",
          },
          status: "success",
          summary: `scaled api-${i}`,
        },
        i,
        () => `ch-${i}`,
      );
    }

    const events = useChangeHistoryStore.getState().events;
    expect(events).toHaveLength(CHANGE_HISTORY_RETENTION_LIMIT);
    expect(events[0].id).toBe(`ch-${CHANGE_HISTORY_RETENTION_LIMIT + 4}`);
    expect(events[events.length - 1]?.id).toBe("ch-5");
  });

  it("does not persist raw secret YAML details", () => {
    useChangeHistoryStore.getState().recordEvent(
      {
        action: "apply",
        target: {
          kind: "secret",
          namespace: "default",
          name: "db-creds",
          context: "dev",
        },
        status: "success",
        summary: "applied secret/db-creds",
        details: {
          yaml: "kind: Secret\ndata:\n  password: c2VjcmV0\n",
        },
      },
      100,
      () => "ch-secret",
    );

    const raw = window.localStorage.getItem(CHANGE_HISTORY_STORAGE_KEY) ?? "";
    expect(raw).not.toContain("c2VjcmV0");
    expect(raw).toContain("[redacted secret manifest]");
  });
});
