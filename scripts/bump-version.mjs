import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const root = process.cwd();
const targets = [
  {
    path: join(root, "package.json"),
    pattern: /("version"\s*:\s*")([^"]+)(")/,
  },
  {
    path: join(root, "src-tauri/tauri.conf.json"),
    pattern: /("version"\s*:\s*")([^"]+)(")/,
  },
  {
    path: join(root, "src-tauri/Cargo.toml"),
    // Only match the [package] version line (first one in the file), not deps.
    pattern: /^(version\s*=\s*")([^"]+)(")/m,
  },
];

const next = process.argv[2];
if (!next || !SEMVER.test(next)) {
  console.error("usage: node scripts/bump-version.mjs <semver>");
  console.error("       e.g. 0.6.2 or 1.0.0-rc.1");
  process.exit(2);
}

const before = [];
for (const target of targets) {
  const text = await readFile(target.path, "utf8");
  const match = text.match(target.pattern);
  if (!match) {
    console.error(`bump: no version found in ${target.path}`);
    process.exit(1);
  }
  before.push({ target, text, current: match[2] });
}

const distinct = [...new Set(before.map((b) => b.current))];
if (distinct.length > 1) {
  console.error("bump: pre-bump versions disagree:");
  for (const b of before) console.error(`  ${b.current}  ${b.target.path}`);
  console.error("fix the manifests by hand before bumping.");
  process.exit(1);
}
const [current] = distinct;
if (current === next) {
  console.error(`bump: already at ${next}, nothing to do`);
  process.exit(0);
}

for (const { target, text } of before) {
  const updated = text.replace(target.pattern, (_, p1, _v, p3) => `${p1}${next}${p3}`);
  await writeFile(target.path, updated);
  console.log(`bump: ${target.path}: ${current} -> ${next}`);
}

await new Promise((resolve, reject) => {
  const child = spawn("cargo", ["update", "--workspace", "--quiet"], {
    cwd: join(root, "src-tauri"),
    stdio: "inherit",
  });
  child.on("error", reject);
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cargo update exited ${code}`))));
});

console.log(`\nbumped ${current} -> ${next}. Review with \`git diff\`, then commit and open a release PR.`);
