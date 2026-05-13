import { create } from "zustand";

export const COPILOT_UI_STORAGE_KEY = "lumen:copilot-ui";

export type CopilotUiSnapshot = {
  isOpen: boolean;
  activeSessionId: string | null;
  draft: string;
};

type CopilotUiStore = CopilotUiSnapshot & {
  hydrate: () => void;
  openDrawer: (sessionId?: string | null) => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  setActiveSession: (sessionId: string | null) => void;
  setDraft: (draft: string) => void;
  startNewInvestigation: () => void;
  reset: () => void;
};

function defaults(): CopilotUiSnapshot {
  return {
    isOpen: false,
    activeSessionId: null,
    draft: "",
  };
}

function readPersisted(): CopilotUiSnapshot {
  if (typeof window === "undefined") return defaults();
  try {
    const raw = window.localStorage.getItem(COPILOT_UI_STORAGE_KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<CopilotUiSnapshot>;
    return {
      isOpen: parsed.isOpen === true,
      activeSessionId:
        typeof parsed.activeSessionId === "string" && parsed.activeSessionId.trim()
          ? parsed.activeSessionId
          : null,
      draft: typeof parsed.draft === "string" ? parsed.draft : "",
    };
  } catch {
    return defaults();
  }
}

function writePersisted(snapshot: CopilotUiSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COPILOT_UI_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Best-effort UI persistence only.
  }
}

function snapshot(state: CopilotUiSnapshot): CopilotUiSnapshot {
  return {
    isOpen: state.isOpen,
    activeSessionId: state.activeSessionId,
    draft: state.draft,
  };
}

function commit(
  set: (partial: Partial<CopilotUiSnapshot>) => void,
  next: CopilotUiSnapshot,
): void {
  writePersisted(next);
  set(next);
}

export const useCopilotUi = create<CopilotUiStore>((set, get) => ({
  ...readPersisted(),
  hydrate: () => {
    commit(set, readPersisted());
  },
  openDrawer: (sessionId) => {
    const next = {
      ...snapshot(get()),
      isOpen: true,
      activeSessionId:
        typeof sessionId === "string" && sessionId.trim()
          ? sessionId
          : get().activeSessionId,
    };
    commit(set, next);
  },
  closeDrawer: () => {
    commit(set, { ...snapshot(get()), isOpen: false });
  },
  toggleDrawer: () => {
    commit(set, { ...snapshot(get()), isOpen: !get().isOpen });
  },
  setActiveSession: (sessionId) => {
    commit(set, {
      ...snapshot(get()),
      activeSessionId:
        typeof sessionId === "string" && sessionId.trim() ? sessionId : null,
    });
  },
  setDraft: (draft) => {
    commit(set, { ...snapshot(get()), draft });
  },
  startNewInvestigation: () => {
    commit(set, {
      isOpen: true,
      activeSessionId: null,
      draft: "",
    });
  },
  reset: () => {
    commit(set, defaults());
  },
}));
