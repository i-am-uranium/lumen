import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("release updater configuration", () => {
  it("enables signed Tauri updater artifacts against GitHub releases", () => {
    const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));

    expect(tauriConfig.bundle.createUpdaterArtifacts).toBe(true);
    expect(tauriConfig.plugins.updater.pubkey).toEqual(expect.any(String));
    expect(tauriConfig.plugins.updater.pubkey).not.toHaveLength(0);
    expect(tauriConfig.plugins.updater.endpoints).toContain(
      "https://github.com/i-am-uranium/lumen/releases/latest/download/latest.json",
    );
    expect(tauriConfig.plugins.updater.windows.installMode).toBe("passive");
  });

  it("registers updater dependencies and frontend permissions", () => {
    const packageJson = JSON.parse(read("package.json"));
    const cargoToml = read("src-tauri/Cargo.toml");
    const libRs = read("src-tauri/src/lib.rs");
    const capabilities = JSON.parse(read("src-tauri/capabilities/default.json"));

    expect(packageJson.dependencies["@tauri-apps/plugin-updater"]).toEqual(expect.any(String));
    expect(packageJson.dependencies["@tauri-apps/plugin-process"]).toEqual(expect.any(String));
    expect(cargoToml).toContain("tauri-plugin-updater");
    expect(libRs).toContain("tauri_plugin_updater::Builder::new().build()");
    expect(capabilities.permissions).toContain("updater:default");
  });

  it("passes updater signing secrets to every release build path", () => {
    const releaseWorkflow = read(".github/workflows/release.yml");
    const buildBlocks = releaseWorkflow.split("- name: Build Tauri app").slice(1);

    expect(buildBlocks.length).toBeGreaterThanOrEqual(4);
    for (const block of buildBlocks) {
      expect(block).toContain("TAURI_SIGNING_PRIVATE_KEY:");
      expect(block).toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD:");
    }
  });

  it("lets Tauri use its CI-safe DMG bundling path", () => {
    const releaseWorkflow = read(".github/workflows/release.yml");

    expect(releaseWorkflow).not.toContain("TAURI_BUNDLER_DMG_IGNORE_CI:");
  });
});
