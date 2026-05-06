/**
 * Pure helpers for the Helm install / upgrade wizards.
 *
 * The route components stay focused on UX — validation, command-line
 * preview, and chart-version grouping live here so they can be unit
 * tested without rendering.
 */

import type { HelmChartHit } from "@/lib/k8s";

export type HelmWizardSpec = {
  /** Chart reference: `repo/name` or an OCI URL. */
  chart: string;
  /** Optional chart version pin. Empty string = latest. */
  version: string;
  /** Helm release name. */
  release: string;
  /** Target namespace. */
  namespace: string;
  /** YAML body to pass via --values. */
  valuesYaml: string;
  /** Whether to pass --create-namespace (install only). */
  createNamespace: boolean;
  /** Whether to pass --atomic (upgrade only). */
  atomic: boolean;
  /** Whether to pass --wait. */
  wait: boolean;
};

/** Bare release-name regex per Helm's chart name validation (RFC 1123 label, max 53). */
const RELEASE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,51}[a-z0-9])?$/;

export function validateInstall(spec: HelmWizardSpec): string[] {
  const errors: string[] = [];
  if (!spec.chart.trim()) errors.push("chart is required");
  if (!spec.release.trim()) errors.push("release name is required");
  else if (!RELEASE_NAME_RE.test(spec.release.trim())) {
    errors.push(
      "release name must be 1-53 chars, lowercase alphanumeric or '-', and start/end alphanumeric",
    );
  }
  if (!spec.namespace.trim()) errors.push("namespace is required");
  return errors;
}

export function validateUpgrade(spec: HelmWizardSpec): string[] {
  // Same shape as install — release is pre-filled and disabled, but we still
  // validate the chart and namespace.
  const errors: string[] = [];
  if (!spec.chart.trim()) errors.push("chart is required");
  if (!spec.release.trim()) errors.push("release name is required");
  if (!spec.namespace.trim()) errors.push("namespace is required");
  return errors;
}

/**
 * Group raw `helm search repo --versions` output by chart name. helm returns
 * one row per (chart, version); the wizard wants one row per chart with a
 * version dropdown. Versions are kept in the order helm returned them, which
 * is descending (newest first) for typical repos.
 */
export type GroupedChart = {
  name: string;
  description: string;
  appVersion: string;
  versions: string[];
};

export function groupSearchHits(hits: HelmChartHit[]): GroupedChart[] {
  const map = new Map<string, GroupedChart>();
  for (const h of hits) {
    const existing = map.get(h.name);
    if (existing) {
      existing.versions.push(h.version);
    } else {
      map.set(h.name, {
        name: h.name,
        description: h.description,
        appVersion: h.app_version,
        versions: [h.version],
      });
    }
  }
  return Array.from(map.values());
}

/**
 * Produce the `helm` invocation that mirrors the wizard's spec, for the
 * "review step" command preview pane. This is purely cosmetic — the actual
 * args go through Tauri — but matching the CLI gives the user a copy-pasteable
 * mental model.
 */
export function buildPreviewCommand(opts: {
  mode: "install" | "upgrade";
  context?: string;
  spec: HelmWizardSpec;
  dryRun: boolean;
}): string {
  const { mode, context, spec, dryRun } = opts;
  const parts: string[] = ["helm", mode, spec.release.trim() || "<release>", spec.chart.trim() || "<chart>"];
  parts.push("--namespace", spec.namespace.trim() || "<namespace>");
  if (mode === "install" && spec.createNamespace) parts.push("--create-namespace");
  if (spec.version.trim()) parts.push("--version", spec.version.trim());
  if (spec.valuesYaml.trim()) parts.push("--values", "-");
  if (mode === "upgrade" && spec.atomic) parts.push("--atomic");
  if (spec.wait) parts.push("--wait");
  if (dryRun) parts.push("--dry-run");
  if (context) parts.push("--kube-context", context);
  return parts.join(" ");
}

/** Maps the wizard spec to the Tauri install request shape. */
export function toInstallRequest(spec: HelmWizardSpec) {
  return {
    release: spec.release.trim(),
    chart: spec.chart.trim(),
    namespace: spec.namespace.trim(),
    version: spec.version.trim() ? spec.version.trim() : null,
    values_yaml: spec.valuesYaml.trim() ? spec.valuesYaml : null,
    create_namespace: spec.createNamespace,
    wait: spec.wait,
  };
}

/** Maps the wizard spec to the Tauri upgrade request shape. */
export function toUpgradeRequest(spec: HelmWizardSpec) {
  return {
    release: spec.release.trim(),
    chart: spec.chart.trim(),
    namespace: spec.namespace.trim(),
    version: spec.version.trim() ? spec.version.trim() : null,
    values_yaml: spec.valuesYaml.trim() ? spec.valuesYaml : null,
    install: false,
    wait: spec.wait,
    atomic: spec.atomic,
  };
}
