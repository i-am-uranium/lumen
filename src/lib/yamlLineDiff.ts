export type YamlDiffLine = { number: number; text: string };
export type YamlDiffRow = {
  before: YamlDiffLine | null;
  after: YamlDiffLine | null;
  changed: boolean;
};
export type YamlLineDiff = {
  rows: YamlDiffRow[];
  additions: number | null;
  deletions: number | null;
  limited: boolean;
};

// Bound both the alignment matrix and the DOM it feeds. Never label an
// approximate/truncated comparison as a complete review of the draft.
const MAX_CHARACTERS = 512_000;
const MAX_LINES = 1_500;
const MAX_CELLS = 1_000_000;

export function yamlLineDiff(before: string, after: string): YamlLineDiff {
  const limited: YamlLineDiff = {
    rows: [],
    additions: null,
    deletions: null,
    limited: true,
  };
  if (before.length + after.length > MAX_CHARACTERS) return limited;
  const left = before === "" ? [] : before.split("\n");
  const right = after === "" ? [] : after.split("\n");
  if (left.length + right.length > MAX_LINES) return limited;
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  const n = left.length - prefix - suffix;
  const m = right.length - prefix - suffix;
  if ((n + 1) * (m + 1) > MAX_CELLS) return limited;
  const matrix = new Uint16Array((n + 1) * (m + 1));
  const width = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      matrix[i * width + j] =
        left[prefix + i] === right[prefix + j]
          ? matrix[(i + 1) * width + j + 1] + 1
          : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1]);
    }
  }
  const rows: YamlDiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  const same = (i: number, j: number) =>
    rows.push({
      before: { number: i + 1, text: left[i] },
      after: { number: j + 1, text: right[j] },
      changed: false,
    });
  for (let i = 0; i < prefix; i++) same(i, i);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && left[prefix + i] === right[prefix + j]) {
      same(prefix + i++, prefix + j++);
      continue;
    }
    const removed: YamlDiffLine[] = [];
    const added: YamlDiffLine[] = [];
    while (i < n || j < m) {
      if (i < n && j < m && left[prefix + i] === right[prefix + j]) break;
      if (
        i < n &&
        (j === m || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])
      ) {
        removed.push({ number: prefix + i + 1, text: left[prefix + i++] });
      } else {
        added.push({ number: prefix + j + 1, text: right[prefix + j++] });
      }
    }
    deletions += removed.length;
    additions += added.length;
    for (let k = 0; k < Math.max(removed.length, added.length); k++)
      rows.push({
        before: removed[k] ?? null,
        after: added[k] ?? null,
        changed: true,
      });
  }
  for (let k = suffix; k > 0; k--) same(left.length - k, right.length - k);
  return { rows, additions, deletions, limited: false };
}
