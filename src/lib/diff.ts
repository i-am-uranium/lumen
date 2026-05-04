export interface Diff {
  adds: { key: string; value: string }[];
  changes: { key: string; before: string; after: string }[];
  removes: { key: string; before: string }[];
  unchanged: string[];
}

export function computeDiff(before: Record<string, string>, after: Record<string, string>): Diff {
  const d: Diff = { adds: [], changes: [], removes: [], unchanged: [] };
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of [...keys].sort()) {
    const b = before[k], a = after[k];
    if (b === undefined && a !== undefined) d.adds.push({ key: k, value: a });
    else if (a === undefined && b !== undefined) d.removes.push({ key: k, before: b });
    else if (b !== a) d.changes.push({ key: k, before: b, after: a });
    else d.unchanged.push(k);
  }
  return d;
}

export function isNoOp(d: Diff): boolean {
  return !d.adds.length && !d.changes.length && !d.removes.length;
}
