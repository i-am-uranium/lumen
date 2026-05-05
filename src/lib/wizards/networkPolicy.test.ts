import { describe, expect, it } from "vitest";
import {
  buildNetworkPolicyManifest,
  finalizeManifest,
  manifestToYaml,
  validate,
  type WizardSpec,
} from "./networkPolicy";

const baseSpec: WizardSpec = {
  name: "allow-internal",
  namespace: "default",
  podSelector: [{ key: "app", value: "api" }],
  ingress: { enabled: true, rules: [] },
  egress: { enabled: false, rules: [] },
};

describe("buildNetworkPolicyManifest", () => {
  it("emits a deny-all-ingress policy when no ingress rules are configured", () => {
    const m = finalizeManifest(buildNetworkPolicyManifest(baseSpec));
    expect(m).toMatchObject({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "allow-internal", namespace: "default" },
      spec: {
        podSelector: { matchLabels: { app: "api" } },
        policyTypes: ["Ingress"],
        ingress: [],
      },
    });
  });

  it("translates rule peers into from[] entries with selectors", () => {
    const m = finalizeManifest(
      buildNetworkPolicyManifest({
        ...baseSpec,
        ingress: {
          enabled: true,
          rules: [
            {
              peers: [
                {
                  podLabel: { key: "role", value: "client" },
                  namespaceLabel: { key: "team", value: "platform" },
                },
                { cidr: "10.0.0.0/8", except: ["10.0.1.0/24"] },
              ],
              ports: [
                { protocol: "TCP", port: "8080" },
                { protocol: "UDP", port: "dns" },
              ],
            },
          ],
        },
      }),
    );
    const rule = (m.spec as { ingress: Array<{ from: unknown[]; ports: unknown[] }> })
      .ingress[0];
    expect(rule.from).toEqual([
      {
        podSelector: { matchLabels: { role: "client" } },
        namespaceSelector: { matchLabels: { team: "platform" } },
      },
      { ipBlock: { cidr: "10.0.0.0/8", except: ["10.0.1.0/24"] } },
    ]);
    expect(rule.ports).toEqual([
      { protocol: "TCP", port: 8080 }, // numeric port stays numeric
      { protocol: "UDP", port: "dns" }, // named port preserved as string
    ]);
  });

  it("renames _peers to `to` for egress direction", () => {
    const m = finalizeManifest(
      buildNetworkPolicyManifest({
        ...baseSpec,
        ingress: { enabled: false, rules: [] },
        egress: {
          enabled: true,
          rules: [
            {
              peers: [{ cidr: "0.0.0.0/0" }],
              ports: [{ protocol: "TCP", port: "443" }],
            },
          ],
        },
      }),
    );
    const rule = (m.spec as { egress: Array<{ to: unknown[]; ports: unknown[] }> })
      .egress[0];
    expect(rule.to).toEqual([{ ipBlock: { cidr: "0.0.0.0/0" } }]);
    expect(rule.ports).toEqual([{ protocol: "TCP", port: 443 }]);
  });

  it("emits empty podSelector when no labels are set (selects all pods)", () => {
    const m = buildNetworkPolicyManifest({ ...baseSpec, podSelector: [] });
    expect((m.spec as { podSelector: unknown }).podSelector).toEqual({});
  });
});

describe("validate", () => {
  it("flags missing name", () => {
    expect(validate({ ...baseSpec, name: "" })).toContain("name is required");
  });
  it("flags non-DNS-1123 name", () => {
    expect(validate({ ...baseSpec, name: "Allow_Bad" })).toContain(
      "name must match DNS-1123 (lowercase, digits, dashes)",
    );
  });
  it("requires at least one direction", () => {
    expect(
      validate({
        ...baseSpec,
        ingress: { enabled: false, rules: [] },
        egress: { enabled: false, rules: [] },
      }),
    ).toContain("select at least one direction (Ingress or Egress)");
  });
  it("returns empty array on a valid spec", () => {
    expect(validate(baseSpec)).toEqual([]);
  });
});

describe("manifestToYaml", () => {
  it("renders a manifest as block-style YAML", () => {
    const yaml = manifestToYaml({
      apiVersion: "v1",
      kind: "Foo",
      metadata: { name: "x", labels: { app: "y" } },
      spec: { ports: [80, 443], paths: ["/health"], empty: {} },
    });
    expect(yaml).toContain("apiVersion: v1");
    expect(yaml).toContain("kind: Foo");
    expect(yaml).toContain("metadata:");
    expect(yaml).toContain("  name: x");
    expect(yaml).toContain("  labels:");
    expect(yaml).toContain("    app: y");
    expect(yaml).toContain("  ports:");
    expect(yaml).toContain("  - 80");
    expect(yaml).toContain("  - 443");
    expect(yaml).toContain("empty: {}");
  });

  it("quotes ambiguous strings", () => {
    expect(manifestToYaml("yes")).toBe("'yes'");
    expect(manifestToYaml("123")).toBe("'123'");
    expect(manifestToYaml("hello")).toBe("hello");
    expect(manifestToYaml("")).toBe('""');
    expect(manifestToYaml("a: b")).toBe("'a: b'");
  });
});
