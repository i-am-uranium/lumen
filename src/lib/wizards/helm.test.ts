import { describe, expect, it } from "vitest";
import {
  buildPreviewCommand,
  groupSearchHits,
  toInstallRequest,
  toUpgradeRequest,
  validateInstall,
  validateUpgrade,
  type HelmWizardSpec,
} from "./helm";

const baseSpec: HelmWizardSpec = {
  chart: "bitnami/redis",
  version: "19.0.1",
  release: "redis-prod",
  namespace: "data",
  valuesYaml: "auth:\n  enabled: true\n",
  createNamespace: false,
  atomic: true,
  wait: false,
};

describe("validateInstall", () => {
  it("accepts a fully populated spec", () => {
    expect(validateInstall(baseSpec)).toEqual([]);
  });

  it("rejects missing chart and release", () => {
    const errs = validateInstall({ ...baseSpec, chart: "", release: "" });
    expect(errs).toEqual(
      expect.arrayContaining(["chart is required", "release name is required"]),
    );
  });

  it("rejects release names containing uppercase or symbols", () => {
    const errs = validateInstall({ ...baseSpec, release: "Redis_Prod!" });
    expect(errs.some((e) => e.includes("release name must"))).toBe(true);
  });

  it("rejects release names that exceed Helm's 53-char cap", () => {
    const tooLong = "a".repeat(54);
    expect(validateInstall({ ...baseSpec, release: tooLong })).toEqual(
      expect.arrayContaining([expect.stringContaining("release name must")]),
    );
  });

  it("accepts a 53-char release name", () => {
    const exact = "a".repeat(53);
    expect(validateInstall({ ...baseSpec, release: exact })).toEqual([]);
  });
});

describe("validateUpgrade", () => {
  it("does not enforce the install-time release-name regex", () => {
    // upgrade pre-fills the existing release and disables the input — we
    // shouldn't reject names a previous install accepted.
    expect(validateUpgrade({ ...baseSpec, release: "legacy_name" })).toEqual([]);
  });
});

describe("groupSearchHits", () => {
  it("collapses repeated chart names and preserves version order", () => {
    const grouped = groupSearchHits([
      {
        name: "bitnami/redis",
        version: "19.0.1",
        app_version: "7.2.4",
        description: "Redis chart",
      },
      {
        name: "bitnami/redis",
        version: "18.19.4",
        app_version: "7.2.4",
        description: "Redis chart",
      },
      {
        name: "acme/foo",
        version: "1.0.0",
        app_version: "1.0",
        description: "Foo",
      },
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]!.versions).toEqual(["19.0.1", "18.19.4"]);
    expect(grouped[1]!.name).toBe("acme/foo");
  });

  it("handles an empty input", () => {
    expect(groupSearchHits([])).toEqual([]);
  });
});

describe("buildPreviewCommand", () => {
  it("emits an install command with the expected flags", () => {
    const cmd = buildPreviewCommand({
      mode: "install",
      context: "prod",
      spec: { ...baseSpec, createNamespace: true, wait: true },
      dryRun: true,
    });
    expect(cmd).toContain("helm install redis-prod bitnami/redis");
    expect(cmd).toContain("--namespace data");
    expect(cmd).toContain("--create-namespace");
    expect(cmd).toContain("--version 19.0.1");
    expect(cmd).toContain("--values -");
    expect(cmd).toContain("--wait");
    expect(cmd).toContain("--dry-run");
    expect(cmd).toContain("--kube-context prod");
    expect(cmd).not.toContain("--atomic"); // install path
  });

  it("emits an upgrade command and surfaces --atomic", () => {
    const cmd = buildPreviewCommand({
      mode: "upgrade",
      spec: baseSpec,
      dryRun: false,
    });
    expect(cmd.startsWith("helm upgrade redis-prod bitnami/redis")).toBe(true);
    expect(cmd).toContain("--atomic");
    expect(cmd).not.toContain("--dry-run");
    expect(cmd).not.toContain("--create-namespace");
  });

  it("uses placeholders when chart/release/namespace are blank", () => {
    const cmd = buildPreviewCommand({
      mode: "install",
      spec: {
        ...baseSpec,
        chart: "",
        release: "",
        namespace: "",
        version: "",
        valuesYaml: "",
      },
      dryRun: false,
    });
    expect(cmd).toContain("<release>");
    expect(cmd).toContain("<chart>");
    expect(cmd).toContain("<namespace>");
    expect(cmd).not.toContain("--version");
    expect(cmd).not.toContain("--values");
  });
});

describe("request mappers", () => {
  it("toInstallRequest trims and nullifies blanks", () => {
    const req = toInstallRequest({
      ...baseSpec,
      chart: "  bitnami/redis  ",
      version: "  ",
      valuesYaml: "   ",
    });
    expect(req.chart).toBe("bitnami/redis");
    expect(req.version).toBeNull();
    expect(req.values_yaml).toBeNull();
  });

  it("toUpgradeRequest preserves values_yaml when non-empty", () => {
    const req = toUpgradeRequest(baseSpec);
    expect(req.values_yaml).toContain("auth:");
    expect(req.atomic).toBe(true);
    expect(req.install).toBe(false);
  });
});
