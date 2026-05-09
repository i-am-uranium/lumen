import { create } from "zustand";
import {
  buildChangeHistoryEvent,
  defaultChangeHistoryId,
  parsePersistedChangeHistoryEvents,
  type ChangeHistoryEvent,
  type ChangeHistoryEventInput,
} from "@/lib/changeHistory";

export const CHANGE_HISTORY_STORAGE_KEY = "lumen:change-history";
export const CHANGE_HISTORY_RETENTION_LIMIT = 500;

type Store = {
  events: ChangeHistoryEvent[];
  recordEvent: (
    input: ChangeHistoryEventInput,
    now?: number,
    makeId?: () => string,
  ) => ChangeHistoryEvent;
  clearEvents: () => void;
};

function readPersisted(): ChangeHistoryEvent[] {
  if (typeof window === "undefined") return [];
  return parsePersistedChangeHistoryEvents(
    window.localStorage.getItem(CHANGE_HISTORY_STORAGE_KEY),
  ).slice(0, CHANGE_HISTORY_RETENTION_LIMIT);
}

function writePersisted(events: ChangeHistoryEvent[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CHANGE_HISTORY_STORAGE_KEY,
      JSON.stringify(events.slice(0, CHANGE_HISTORY_RETENTION_LIMIT)),
    );
  } catch {
    // Best-effort local history persistence.
  }
}

export const useChangeHistoryStore = create<Store>((set, get) => ({
  events: readPersisted(),
  recordEvent: (input, now = Date.now(), makeId = defaultChangeHistoryId) => {
    const event = buildChangeHistoryEvent(input, now, makeId);
    const next = [event, ...get().events].slice(0, CHANGE_HISTORY_RETENTION_LIMIT);
    writePersisted(next);
    set({ events: next });
    return event;
  },
  clearEvents: () => {
    writePersisted([]);
    set({ events: [] });
  },
}));
