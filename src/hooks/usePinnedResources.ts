import { useCallback, useEffect, useState } from "react";

export type PinnedRef = {
  kind: string;
  namespace: string | null;
  name: string;
};

export type Pinned = {
  items: PinnedRef[];
  isPinned: (ref: PinnedRef) => boolean;
  pin: (ref: PinnedRef) => void;
  unpin: (ref: PinnedRef) => void;
  toggle: (ref: PinnedRef) => void;
};

const storageKey = (ctx: string) => `lumen:pinned:${ctx}`;

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
    // Defensive: only accept entries with the expected shape.
    return parsed.filter(
      (e): e is PinnedRef =>
        e &&
        typeof e === "object" &&
        typeof e.kind === "string" &&
        typeof e.name === "string" &&
        (e.namespace === null || typeof e.namespace === "string"),
    );
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

export function usePinnedResources(ctx: string): Pinned {
  const [items, setItems] = useState<PinnedRef[]>(() => readItems(ctx));

  useEffect(() => {
    setItems(readItems(ctx));
  }, [ctx]);

  const isPinned = useCallback(
    (ref: PinnedRef) => items.some((i) => refsEqual(i, ref)),
    [items],
  );

  const pin = useCallback(
    (ref: PinnedRef) => {
      setItems((prev) => {
        if (prev.some((i) => refsEqual(i, ref))) return prev;
        const next = [...prev, ref];
        writeItems(ctx, next);
        return next;
      });
    },
    [ctx],
  );

  const unpin = useCallback(
    (ref: PinnedRef) => {
      setItems((prev) => {
        const next = prev.filter((i) => !refsEqual(i, ref));
        if (next.length === prev.length) return prev;
        writeItems(ctx, next);
        return next;
      });
    },
    [ctx],
  );

  const toggle = useCallback(
    (ref: PinnedRef) => {
      setItems((prev) => {
        const exists = prev.some((i) => refsEqual(i, ref));
        const next = exists
          ? prev.filter((i) => !refsEqual(i, ref))
          : [...prev, ref];
        writeItems(ctx, next);
        return next;
      });
    },
    [ctx],
  );

  return { items, isPinned, pin, unpin, toggle };
}
