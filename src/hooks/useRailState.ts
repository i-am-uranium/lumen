import { useCallback, useEffect, useState } from "react";

export type RailState = {
  collapsed: boolean;
  toggleCollapsed: () => void;
  isGroupOpen: (groupId: string) => boolean;
  toggleGroup: (groupId: string) => void;
};

const COLLAPSED_KEY = "lumen:rail:collapsed";
const groupsKey = (ctx: string) => `lumen:rail:groups:${ctx}`;

// Defaults: triage expanded, pinned/recent expanded by default. Other
// groups start collapsed so the primary operator path stays visible.
const DEFAULT_GROUPS: Record<string, boolean> = {
  pinned: true,
  recent: true,
  triage: true,
};

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or serialization errors are non-fatal */
  }
}

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "true" : "false");
  } catch {
    /* non-fatal */
  }
}

export function useRailState(ctx: string): RailState {
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    readBool(COLLAPSED_KEY, false),
  );
  const [groups, setGroups] = useState<Record<string, boolean>>(() =>
    readJson<Record<string, boolean>>(groupsKey(ctx), DEFAULT_GROUPS),
  );

  // When the active cluster context changes, swap in that ctx's group state.
  useEffect(() => {
    setGroups(
      readJson<Record<string, boolean>>(groupsKey(ctx), DEFAULT_GROUPS),
    );
  }, [ctx]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeBool(COLLAPSED_KEY, next);
      return next;
    });
  }, []);

  const isGroupOpen = useCallback(
    (groupId: string) => {
      if (groupId in groups) return groups[groupId];
      return DEFAULT_GROUPS[groupId] ?? false;
    },
    [groups],
  );

  const toggleGroup = useCallback(
    (groupId: string) => {
      setGroups((prev) => {
        const current =
          groupId in prev ? prev[groupId] : (DEFAULT_GROUPS[groupId] ?? false);
        const next = { ...prev, [groupId]: !current };
        writeJson(groupsKey(ctx), next);
        return next;
      });
    },
    [ctx],
  );

  return { collapsed, toggleCollapsed, isGroupOpen, toggleGroup };
}
