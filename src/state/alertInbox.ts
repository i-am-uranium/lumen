import { create } from "zustand";
import type { AlertInboxItem } from "@/lib/alertInbox";

export const ALERT_INBOX_STORAGE_KEY = "lumen:alert-inbox";

const RETENTION_MS = 30 * 24 * 60 * 60_000;

export type PersistedAlertInboxState = {
  acknowledged: Record<string, number>;
  snoozedUntil: Record<string, number>;
  read: Record<string, number>;
  restartCounts: Record<string, number>;
};

export type StatefulAlertInboxItem = AlertInboxItem & {
  acknowledged: boolean;
  acknowledgedAtMs: number | null;
  snoozed: boolean;
  snoozedUntilMs: number | null;
  read: boolean;
  readAtMs: number | null;
};

type Store = PersistedAlertInboxState & {
  acknowledge: (fingerprint: string, now?: number) => void;
  unacknowledge: (fingerprint: string) => void;
  snooze: (fingerprint: string, untilMs: number) => void;
  unsnooze: (fingerprint: string) => void;
  markRead: (fingerprints: string[], now?: number) => void;
  replaceRestartCounts: (counts: Record<string, number>) => void;
  prune: (options: PruneOptions) => void;
  reset: () => void;
};

type PruneOptions = {
  nowMs: number;
  activeFingerprints: Set<string>;
  activeRestartKeys: Set<string>;
};

function emptyState(): PersistedAlertInboxState {
  return {
    acknowledged: {},
    snoozedUntil: {},
    read: {},
    restartCounts: {},
  };
}

function numericRecord(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === "string" && typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

function readPersisted(): PersistedAlertInboxState {
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = window.localStorage.getItem(ALERT_INBOX_STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<PersistedAlertInboxState>;
    return {
      acknowledged: numericRecord(parsed.acknowledged),
      snoozedUntil: numericRecord(parsed.snoozedUntil),
      read: numericRecord(parsed.read),
      restartCounts: numericRecord(parsed.restartCounts),
    };
  } catch {
    return emptyState();
  }
}

function writePersisted(state: PersistedAlertInboxState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ALERT_INBOX_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort local state.
  }
}

function snapshot(state: PersistedAlertInboxState): PersistedAlertInboxState {
  return {
    acknowledged: { ...state.acknowledged },
    snoozedUntil: { ...state.snoozedUntil },
    read: { ...state.read },
    restartCounts: { ...state.restartCounts },
  };
}

function sameRecord(a: Record<string, number>, b: Record<string, number>): boolean {
  const aEntries = Object.entries(a);
  if (aEntries.length !== Object.keys(b).length) return false;
  return aEntries.every(([key, value]) => b[key] === value);
}

function sameState(a: PersistedAlertInboxState, b: PersistedAlertInboxState): boolean {
  return (
    sameRecord(a.acknowledged, b.acknowledged) &&
    sameRecord(a.snoozedUntil, b.snoozedUntil) &&
    sameRecord(a.read, b.read) &&
    sameRecord(a.restartCounts, b.restartCounts)
  );
}

export function applyAlertInboxState(
  alerts: AlertInboxItem[],
  state: PersistedAlertInboxState,
  nowMs: number,
): StatefulAlertInboxItem[] {
  return alerts.map((alert) => {
    const acknowledgedAtMs = state.acknowledged[alert.fingerprint] ?? null;
    const snoozedUntilMs = state.snoozedUntil[alert.fingerprint] ?? null;
    const readAtMs = state.read[alert.fingerprint] ?? null;
    return {
      ...alert,
      acknowledged: acknowledgedAtMs !== null,
      acknowledgedAtMs,
      snoozed: snoozedUntilMs !== null && snoozedUntilMs > nowMs,
      snoozedUntilMs,
      read: readAtMs !== null,
      readAtMs,
    };
  });
}

export function pruneAlertInboxState(
  state: PersistedAlertInboxState,
  options: PruneOptions,
): PersistedAlertInboxState {
  const cutoff = options.nowMs - RETENTION_MS;
  const keepByActiveOrFresh = (entries: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(entries).filter(
        ([fingerprint, atMs]) =>
          options.activeFingerprints.has(fingerprint) || atMs >= cutoff,
      ),
    );

  return {
    acknowledged: keepByActiveOrFresh(state.acknowledged),
    snoozedUntil: Object.fromEntries(
      Object.entries(state.snoozedUntil).filter(
        ([fingerprint, untilMs]) =>
          untilMs > options.nowMs && options.activeFingerprints.has(fingerprint),
      ),
    ),
    read: keepByActiveOrFresh(state.read),
    restartCounts: Object.fromEntries(
      Object.entries(state.restartCounts).filter(([key]) =>
        options.activeRestartKeys.has(key),
      ),
    ),
  };
}

export const useAlertInboxStore = create<Store>((set, get) => {
  const initial = readPersisted();
  const persist = (next: PersistedAlertInboxState) => {
    if (sameState(snapshot(get()), next)) return;
    writePersisted(next);
    set(next);
  };

  return {
    ...initial,
    acknowledge: (fingerprint, now = Date.now()) => {
      const next = snapshot(get());
      next.acknowledged[fingerprint] = now;
      persist(next);
    },
    unacknowledge: (fingerprint) => {
      const next = snapshot(get());
      delete next.acknowledged[fingerprint];
      persist(next);
    },
    snooze: (fingerprint, untilMs) => {
      const next = snapshot(get());
      next.snoozedUntil[fingerprint] = untilMs;
      persist(next);
    },
    unsnooze: (fingerprint) => {
      const next = snapshot(get());
      delete next.snoozedUntil[fingerprint];
      persist(next);
    },
    markRead: (fingerprints, now = Date.now()) => {
      const next = snapshot(get());
      for (const fingerprint of fingerprints) {
        next.read[fingerprint] = now;
      }
      persist(next);
    },
    replaceRestartCounts: (counts) => {
      const next = snapshot(get());
      next.restartCounts = { ...counts };
      persist(next);
    },
    prune: (options) => {
      persist(pruneAlertInboxState(snapshot(get()), options));
    },
    reset: () => {
      const next = emptyState();
      writePersisted(next);
      set(next);
    },
  };
});
