import { useCallback, useEffect, useState } from "react";
import type { PinnedRef } from "./usePinnedResources";

export type Recent = {
  items: PinnedRef[];
  push: (ref: PinnedRef) => void;
  clear: () => void;
};

const MAX = 10;
const storageKey = (ctx: string) => `lumen:recent:${ctx}`;

function refsEqual(a: PinnedRef, b: PinnedRef): boolean {
  return a.kind === b.kind && a.name === b.name && a.namespace === b.namespace;
}

function readItems(ctx: string): PinnedRef[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(ctx));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is PinnedRef =>
          e &&
          typeof e === "object" &&
          typeof e.kind === "string" &&
          typeof e.name === "string" &&
          (e.namespace === null || typeof e.namespace === "string"),
      )
      .slice(0, MAX);
  } catch {
    return [];
  }
}

function writeItems(ctx: string, items: PinnedRef[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(ctx), JSON.stringify(items));
  } catch {
    /* non-fatal */
  }
}

export function useRecentResources(ctx: string): Recent {
  const [items, setItems] = useState<PinnedRef[]>(() => readItems(ctx));

  useEffect(() => {
    setItems(readItems(ctx));
  }, [ctx]);

  const push = useCallback(
    (ref: PinnedRef) => {
      setItems((prev) => {
        // MRU: drop any existing match, prepend new ref, cap at MAX.
        const filtered = prev.filter((i) => !refsEqual(i, ref));
        const next = [ref, ...filtered].slice(0, MAX);
        writeItems(ctx, next);
        return next;
      });
    },
    [ctx],
  );

  const clear = useCallback(() => {
    setItems([]);
    writeItems(ctx, []);
  }, [ctx]);

  return { items, push, clear };
}
