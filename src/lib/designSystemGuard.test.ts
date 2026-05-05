import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import baseline from "./designSystemGuard.baseline.json";

const SOURCE_FILES: string[] = globSync("src/**/*.{ts,tsx,css}", {
  exclude: ["**/*.test.ts", "**/*.test.tsx", "src/index.css"],
}).sort();

function findMatches(file: string, pattern: RegExp): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line: string, index: number) => (pattern.test(line) ? [`${file}:${index + 1}`] : []));
}

// Tailwind palette names we consider "raw" — i.e. not part of our semantic
// token surface (success, warning, danger, info, accent-primary, etc.).
// Lookbehind for `dark:` so existing light/dark paired classes (e.g.
// `bg-emerald-600 dark:bg-emerald-300`) do not get flagged on the dark
// half. The light half still does — by design — and gets baselined.
const RAW_TW_PALETTE =
  /(?<!dark:)\b(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:zinc|slate|stone|neutral|gray|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+/;

describe("design system guard", () => {
  it("blocks new inline route-level style objects", () => {
    const matches = SOURCE_FILES.filter((file: string) => file.startsWith("src/routes/")).flatMap((file: string) =>
      findMatches(file, /style=\{\{/),
    );

    expect(matches).toEqual(baseline.routeInlineStyles);
  });

  it("blocks new raw hex color literals outside token declarations", () => {
    const matches = SOURCE_FILES.flatMap((file: string) => findMatches(file, /#[0-9a-fA-F]{3,8}/));

    expect(matches).toEqual(baseline.rawHexColors);
  });

  it("blocks new raw Tailwind color classes outside dark: variant pairs", () => {
    const matches = SOURCE_FILES.flatMap((file: string) => findMatches(file, RAW_TW_PALETTE));

    expect(matches).toEqual(baseline.rawTailwindColors);
  });
});
