import { describe, expect, it } from "vitest";
import {
  analyzeYamlPreflight,
  buildActionPreflight,
  type PreflightTarget,
} from "./preflight";

const target: PreflightTarget = {
  kind: "deployment",
  namespace: "prod",
  name: "api",
};

describe("preflight impact analysis", () => {
  it("marks selector and probe changes as high-risk YAML apply impact", () => {
    const beforeYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: prod
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    spec:
      containers:
      - name: api
        image: ghcr.io/acme/api:v1
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
        resources:
          requests:
            cpu: 100m
          limits:
            memory: 256Mi
`;
    const afterYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: prod
spec:
  replicas: 5
  selector:
    matchLabels:
      app: api-v2
  template:
    spec:
      containers:
      - name: api
        image: ghcr.io/acme/api:v2
        resources:
          requests:
            cpu: 500m
`;

    const impact = analyzeYamlPreflight({
      actionType: "apply",
      target,
      beforeYaml,
      afterYaml,
    });

    expect(impact.riskLevel).toBe("high");
    expect(impact.requiresExplicitConfirm).toBe(true);
    expect(impact.affectedResourceCount).toBe(1);
    expect(impact.podChurn).toMatchObject({ level: "high", estimatedPods: 5 });
    expect(impact.diffs.map((diff) => diff.category)).toEqual(
      expect.arrayContaining([
        "image",
        "replicas",
        "selector",
        "probe",
        "resources",
      ]),
    );
    expect(impact.warnings.map((warning) => warning.message).join("\n")).toMatch(
      /selector/i,
    );
  });

  it("detects service, ingress, network policy, and RBAC broadening", () => {
    const beforeYaml = `
kind: Service
metadata:
  name: api
  namespace: prod
spec:
  selector:
    app: api
  ports:
  - port: 80
---
kind: Ingress
metadata:
  name: api
  namespace: prod
spec:
  rules:
  - host: api.example.com
---
kind: NetworkPolicy
metadata:
  name: api
  namespace: prod
spec:
  podSelector:
    matchLabels:
      app: api
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: web
---
kind: Role
metadata:
  name: reader
  namespace: prod
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get"]
`;
    const afterYaml = `
kind: Service
metadata:
  name: api
  namespace: prod
spec:
  selector:
    app: api-v2
  ports:
  - port: 443
---
kind: Ingress
metadata:
  name: api
  namespace: prod
spec:
  rules:
  - host: api.example.com
  - host: admin.example.com
---
kind: NetworkPolicy
metadata:
  name: api
  namespace: prod
spec:
  podSelector: {}
  ingress:
  - {}
---
kind: Role
metadata:
  name: reader
  namespace: prod
rules:
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["*"]
`;

    const impact = analyzeYamlPreflight({
      actionType: "apply",
      target: { kind: "service", namespace: "prod", name: "api" },
      beforeYaml,
      afterYaml,
    });

    expect(impact.riskLevel).toBe("high");
    expect(impact.serviceRisk).toBe("selector-or-port-change");
    expect(impact.diffs.map((diff) => diff.category)).toEqual(
      expect.arrayContaining([
        "service",
        "ingress",
        "network-policy",
        "rbac",
      ]),
    );
  });

  it("summarizes workload restart blast radius from selected resources", () => {
    const impact = buildActionPreflight({
      actionType: "restart",
      targets: [
        { kind: "deployment", namespace: "prod", name: "api", replicas: 3 },
        { kind: "daemonset", namespace: "prod", name: "agent", replicas: 8 },
      ],
    });

    expect(impact.affectedResourceCount).toBe(2);
    expect(impact.podChurn).toMatchObject({ level: "medium", estimatedPods: 11 });
    expect(impact.warnings.map((warning) => warning.message).join("\n")).toMatch(
      /rolling restart/i,
    );
  });
});
