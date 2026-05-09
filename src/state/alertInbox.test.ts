import { beforeEach, describe, expect, it } from "vitest";
import {
  ALERT_INBOX_STORAGE_KEY,
  applyAlertInboxState,
  pruneAlertInboxState,
  useAlertInboxStore,
  type PersistedAlertInboxState,
} from "./alertInbox";

const now = Date.parse("2026-05-09T10:30:00Z");

function state(overrides: Partial<PersistedAlertInboxState> = {}): PersistedAlertInboxState {
  return {
    acknowledged: {},
    snoozedUntil: {},
    read: {},
    restartCounts: {},
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useAlertInboxStore.getState().reset();
});

describe("alert inbox persistence helpers", () => {
  it("applies acknowledge, read, and active snooze state to alerts", () => {
    const [alert] = applyAlertInboxState(
      [
        {
          fingerprint: "pod-restart-increase:pod:checkout/api-7b9",
          ruleId: "pod-restart-increase",
          severity: "high",
          title: "Pod restart count increased",
          resource: { kind: "pod", namespace: "checkout", name: "api-7b9" },
          evidence: ["5 total restarts"],
          nextChecks: ["Open logs"],
          firstSeenMs: now - 60_000,
          lastSeenMs: now,
        },
      ],
      state({
        acknowledged: { "pod-restart-increase:pod:checkout/api-7b9": now - 5_000 },
        snoozedUntil: { "pod-restart-increase:pod:checkout/api-7b9": now + 15 * 60_000 },
        read: { "pod-restart-increase:pod:checkout/api-7b9": now - 1_000 },
      }),
      now,
    );

    expect(alert.acknowledged).toBe(true);
    expect(alert.snoozed).toBe(true);
    expect(alert.snoozedUntilMs).toBe(now + 15 * 60_000);
    expect(alert.read).toBe(true);
  });

  it("prunes stale persisted entries and keeps restart baselines for active pods", () => {
    const pruned = pruneAlertInboxState(
      state({
        acknowledged: { active: now - 1_000, stale: now - 40 * 24 * 60 * 60_000 },
        snoozedUntil: { active: now + 1_000, expired: now - 1_000 },
        read: { active: now - 2_000, stale: now - 40 * 24 * 60 * 60_000 },
        restartCounts: {
          "pod:checkout/api-7b9": 5,
          "pod:checkout/gone": 2,
        },
      }),
      {
        nowMs: now,
        activeFingerprints: new Set(["active"]),
        activeRestartKeys: new Set(["pod:checkout/api-7b9"]),
      },
    );

    expect(pruned).toEqual({
      acknowledged: { active: now - 1_000 },
      snoozedUntil: { active: now + 1_000 },
      read: { active: now - 2_000 },
      restartCounts: { "pod:checkout/api-7b9": 5 },
    });
  });

  it("persists acknowledge, snooze, read, and restart samples through the store", () => {
    const store = useAlertInboxStore.getState();
    store.acknowledge("fp-1", now);
    store.snooze("fp-1", now + 30 * 60_000);
    store.markRead(["fp-1", "fp-2"], now + 1_000);
    store.replaceRestartCounts({ "pod:checkout/api-7b9": 6 });

    expect(useAlertInboxStore.getState()).toMatchObject({
      acknowledged: { "fp-1": now },
      snoozedUntil: { "fp-1": now + 30 * 60_000 },
      read: { "fp-1": now + 1_000, "fp-2": now + 1_000 },
      restartCounts: { "pod:checkout/api-7b9": 6 },
    });
    expect(
      JSON.parse(window.localStorage.getItem(ALERT_INBOX_STORAGE_KEY) ?? "{}"),
    ).toMatchObject({
      acknowledged: { "fp-1": now },
      snoozedUntil: { "fp-1": now + 30 * 60_000 },
      read: { "fp-1": now + 1_000, "fp-2": now + 1_000 },
      restartCounts: { "pod:checkout/api-7b9": 6 },
    });

    useAlertInboxStore.getState().unacknowledge("fp-1");
    useAlertInboxStore.getState().unsnooze("fp-1");

    expect(useAlertInboxStore.getState().acknowledged).toEqual({});
    expect(useAlertInboxStore.getState().snoozedUntil).toEqual({});
  });
});
