import { describe, expect, it } from "vitest";
import { summarizeSmartDiff, summarizeSmartYamlDiff } from "./smartDiff";

describe("summarizeSmartDiff", () => {
  it("classifies workload changes by operational impact", () => {
    const before = {
      kind: "Deployment",
      spec: {
        replicas: 2,
        template: {
          spec: {
            containers: [
              {
                name: "api",
                image: "ghcr.io/acme/api:1.0.0",
                envFrom: [{ configMapRef: { name: "api-config-v1" } }],
                readinessProbe: { httpGet: { path: "/ready", port: 8080 } },
                resources: { requests: { cpu: "100m" } },
              },
            ],
          },
        },
      },
    };
    const after = {
      kind: "Deployment",
      spec: {
        replicas: 4,
        template: {
          spec: {
            containers: [
              {
                name: "api",
                image: "ghcr.io/acme/api:1.1.0",
                envFrom: [{ secretRef: { name: "api-secret-v2" } }],
                readinessProbe: { httpGet: { path: "/healthz", port: 8080 } },
                resources: { requests: { cpu: "250m" } },
              },
            ],
          },
        },
      },
    };

    const summary = summarizeSmartDiff(before, after);

    expect(summary.isNoOp).toBe(false);
    expect(summary.changes.map((change) => change.category)).toEqual([
      "image",
      "replicas",
      "env",
      "probe",
      "resources",
    ]);
    expect(summary.changes[0]).toMatchObject({
      category: "image",
      severity: "high",
      title: "Container image changed",
      path: "spec.template.spec.containers[api].image",
      before: "ghcr.io/acme/api:1.0.0",
      after: "ghcr.io/acme/api:1.1.0",
    });
  });

  it("classifies networking and RBAC changes before generic changes", () => {
    const before = {
      kind: "Service",
      spec: {
        selector: { app: "api" },
        ports: [{ port: 80, targetPort: 8080 }],
      },
      subjects: [{ kind: "ServiceAccount", name: "viewer" }],
      rules: [{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }],
    };
    const after = {
      kind: "Service",
      spec: {
        selector: { app: "api-v2" },
        ports: [{ port: 443, targetPort: 8443 }],
      },
      subjects: [{ kind: "ServiceAccount", name: "admin" }],
      rules: [{ apiGroups: [""], resources: ["secrets"], verbs: ["list"] }],
    };

    const summary = summarizeSmartDiff(before, after);

    expect(summary.changes.map((change) => change.category)).toEqual([
      "service",
      "service",
      "rbac",
      "rbac",
    ]);
    expect(summary.byCategory).toMatchObject({
      service: 2,
      rbac: 2,
    });
  });
});

describe("summarizeSmartYamlDiff", () => {
  it("extracts meaningful changes from common Kubernetes YAML", () => {
    const before = [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "spec:",
      "  replicas: 1",
      "  template:",
      "    spec:",
      "      containers:",
      "        - name: api",
      "          image: ghcr.io/acme/api:1.0.0",
      "",
    ].join("\n");
    const after = before
      .replace("replicas: 1", "replicas: 3")
      .replace("ghcr.io/acme/api:1.0.0", "ghcr.io/acme/api:1.1.0");

    const summary = summarizeSmartYamlDiff(before, after);

    expect(summary.changes.map((change) => change.category)).toEqual([
      "image",
      "replicas",
    ]);
  });
});
