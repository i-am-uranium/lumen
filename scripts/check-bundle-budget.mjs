import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const budgets = [
  { label: "main app chunk", pattern: /^index-.*\.js$/, maxKb: 500 },
  { label: "terminal chunk", pattern: /^ShellTerminalHost-.*\.js$/, maxKb: 430 },
  // Workloads chunk includes ResourceDetailDrawer + the inline scan/severity
  // helpers. Set-image, compare-across-clusters, and vuln-scan dialogs are
  // lazy-loaded into their own chunks (see ResourceDetailDrawer.tsx). After
  // that split landed, the chunk dropped from ~90 KiB back to ~85 KiB; the
  // budget is set with a small headroom for future drawer additions. If
  // this climbs back toward 100 KiB, lazy-split the next-largest section
  // (likely PropertiesTab subtrees) before raising the cap.
  { label: "workloads route", pattern: /^WorkloadsView-.*\.js$/, maxKb: 95 },
];

const assetsDir = join(process.cwd(), "dist", "assets");
const files = await readdir(assetsDir);
let failed = false;

for (const budget of budgets) {
  const matches = files.filter((file) => budget.pattern.test(file));
  if (matches.length === 0) {
    console.error(`bundle budget: missing ${budget.label}`);
    failed = true;
    continue;
  }
  const sizes = await Promise.all(
    matches.map(async (file) => ({
      file,
      kb: (await stat(join(assetsDir, file))).size / 1024,
    })),
  );
  const largest = sizes.sort((a, b) => b.kb - a.kb)[0];
  const ok = largest.kb <= budget.maxKb;
  const line = `${budget.label}: ${largest.kb.toFixed(1)} KiB <= ${budget.maxKb} KiB (${largest.file})`;
  if (ok) {
    console.log(line);
  } else {
    console.error(`bundle budget exceeded: ${line}`);
    failed = true;
  }
}

if (failed) process.exit(1);
