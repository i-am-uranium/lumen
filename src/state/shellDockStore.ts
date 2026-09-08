import { create } from "zustand";
import { ShellSession, type ShellSessionKey } from "./shellSession";

export type ShellTab = {
  id: string;
  session: ShellSession;
  /** Display fields snapshot-copied from session for tab strip rendering. */
  podName: string;
  container: string;
  commandLabel: string;
};

const MRU_STORAGE_KEY = "lumen:shell-dock:mru";
const MRU_CAP = 8;

type Store = {
  tabs: ShellTab[];
  activeTabId: string | null;
  isOpen: boolean;
  mru: ShellSessionKey[];
  openSession: (key: ShellSessionKey) => string;
  replaceSession: (id: string, selection: Pick<ShellSessionKey, "container" | "command">) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  closeDock: () => void;
  addToMru: (key: ShellSessionKey) => void;
};

function shortLabel(cmd: ReadonlyArray<string>): string {
  if (cmd.length === 0) return "sh";
  const first = cmd[0];
  const slash = first.lastIndexOf("/");
  return slash >= 0 ? first.slice(slash + 1) : first;
}

function mruKey(k: ShellSessionKey): string {
  return `${k.context}\u0000${k.namespace}\u0000${k.pod}`;
}

function loadMru(): ShellSessionKey[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MRU_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is ShellSessionKey =>
          e &&
          typeof e.pod === "string" &&
          (e.podUid === undefined || typeof e.podUid === "string") &&
          typeof e.namespace === "string" &&
          typeof e.context === "string" &&
          typeof e.container === "string" &&
          Array.isArray(e.command),
      )
      .slice(0, MRU_CAP);
  } catch {
    return [];
  }
}

function saveMru(mru: ShellSessionKey[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MRU_STORAGE_KEY, JSON.stringify(mru));
  } catch {
    // ignore quota / disabled storage
  }
}

let nextTabId = 0;

export const useShellDockStore = create<Store>((set, get) => ({
  tabs: [],
  activeTabId: null,
  isOpen: false,
  mru: loadMru(),
  openSession: (key) => {
    const session = new ShellSession(key);
    const id = `shell-tab-${nextTabId++}`;
    const tab: ShellTab = {
      id,
      session,
      podName: key.pod,
      container: key.container,
      commandLabel: shortLabel(key.command),
    };
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: id,
      isOpen: true,
    }));
    get().addToMru(key);
    return id;
  },
  replaceSession: (id, selection) => {
    const tab = get().tabs.find((item) => item.id === id);
    if (!tab || tab.session.getState() === "live" || tab.session.getState() === "starting") return;
    const key: ShellSessionKey = {
      context: tab.session.context, namespace: tab.session.namespace, pod: tab.session.pod,
      ...(tab.session.podUid ? { podUid: tab.session.podUid } : {}),
      container: selection.container, command: [...selection.command],
    };
    tab.session.close();
    const session = new ShellSession(key);
    set((s) => ({ tabs: s.tabs.map((item) => item.id === id ? {
      ...item, session, container: key.container, commandLabel: shortLabel(key.command),
    } : item) }));
    get().addToMru(key);
    void session.start(80, 24);
  },
  closeTab: (id) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (tab) tab.session.close();
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId =
        s.activeTabId === id ? (tabs[0]?.id ?? null) : s.activeTabId;
      return { tabs, activeTabId, isOpen: tabs.length > 0 };
    }),
  setActiveTab: (id) =>
    set((s) => ({ activeTabId: s.tabs.some((t) => t.id === id) ? id : s.activeTabId })),
  closeDock: () =>
    set((s) => {
      for (const t of s.tabs) t.session.close();
      return { tabs: [], activeTabId: null, isOpen: false };
    }),
  addToMru: (key) =>
    set((s) => {
      const target = mruKey(key);
      const filtered = s.mru.filter((e) => mruKey(e) !== target);
      const next = [key, ...filtered].slice(0, MRU_CAP);
      saveMru(next);
      return { mru: next };
    }),
}));
