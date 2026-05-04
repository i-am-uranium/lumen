import { globSync, readFileSync, writeFileSync } from "node:fs";

const SOURCE_FILES = globSync("src/**/*.{ts,tsx,css}", {
  exclude: ["**/*.test.ts", "**/*.test.tsx", "src/index.css"],
}).sort();

function findMatches(file, pattern) {
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}`] : []));
}

const routeInlineStyles = SOURCE_FILES.filter((file) => file.startsWith("src/routes/")).flatMap((file) =>
  findMatches(file, /style=\{\{/),
);

const rawHexColors = SOURCE_FILES.flatMap((file) => findMatches(file, /#[0-9a-fA-F]{3,8}/));

writeFileSync(
  "src/lib/designSystemGuard.baseline.json",
  `${JSON.stringify({ routeInlineStyles, rawHexColors }, null, 2)}\n`,
  "utf8",
);

console.log("Updated src/lib/designSystemGuard.baseline.json");
