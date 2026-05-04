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
});
