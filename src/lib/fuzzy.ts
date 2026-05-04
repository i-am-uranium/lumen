// Minimal subsequence-match ranker. No external dep needed at our data size.
export function fuzzyRank(query: string, items: string[]): string[] {
  const q = query.toLowerCase();
  if (!q) return items;
  return items
    .map((s) => ({ s, score: score(s.toLowerCase(), q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}

function score(hay: string, needle: string): number {
  let hi = 0, ni = 0, streak = 0, best = 0, matched = 0;
  while (hi < hay.length && ni < needle.length) {
    if (hay[hi] === needle[ni]) {
      ni++; matched++; streak++; best = Math.max(best, streak);
    } else {
      streak = 0;
    }
    hi++;
  }
  return matched === needle.length ? matched * 10 + best : 0;
}
