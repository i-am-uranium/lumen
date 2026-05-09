import { describe, expect, it } from "vitest";
import {
  analyzeNetworkPath,
  labelsMatchSelector,
  type NetworkDebugSnapshot,
} from "./networkDebugger";

const baseSnapshot: NetworkDebugSnapshot = {
  namespaces: [{ name: "shop", labels: { team: "storefront" } }],
  pods: [
    {
      name: "web-1",
      namespace: "shop",
      labels: { app: "web", role: "frontend" },
      ready: true,
      phase: "Running",
      podIp: "10.1.0.10",
      ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }],
    },
    {
      name: "api-1",
      namespace: "shop",
      labels: { app: "api", role: "backend" },
      ready: true,
      phase: "Running",
      podIp: "10.1.0.20",
      ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }],
    },
    {
      name: "api-2",
      namespace: "shop",
      labels: { app: "api", role: "backend" },
      ready: false,
      phase: "Running",
      podIp: "10.1.0.21",
      ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }],
    },
  ],
  services: [
    {
      name: "api",
      namespace: "shop",
      type: "ClusterIP",
      selector: { app: "api" },
      ports: [
        {
          name: "http",
          protocol: "TCP",
          port: 80,
          targetPort: "http",
        },
      ],
    },
  ],
  endpoints: [],
  endpointSlices: [
    {
      name: "api-abc",
      namespace: "shop",
      serviceName: "api",
      ports: [{ name: "http", protocol: "TCP", port: 8080 }],
      endpoints: [
        {
          addresses: ["10.1.0.20"],
          ready: true,
          targetRef: { kind: "Pod", name: "api-1", namespace: "shop" },
        },
        {
          addresses: ["10.1.0.21"],
          ready: false,
          targetRef: { kind: "Pod", name: "api-2", namespace: "shop" },
        },
      ],
    },
  ],
  ingresses: [
    {
      name: "shop",
      namespace: "shop",
      rules: [
        {
          host: "shop.example.com",
          paths: [
            {
              path: "/api",
              pathType: "Prefix",
              serviceName: "api",
              servicePort: "http",
            },
          ],
        },
      ],
    },
  ],
  networkPolicies: [],
};

describe("labelsMatchSelector", () => {
  it("requires every selector label to match the candidate labels", () => {
    expect(labelsMatchSelector({ app: "api" }, { app: "api", tier: "backend" })).toBe(
      true,
    );
    expect(labelsMatchSelector({ app: "api", tier: "backend" }, { app: "api" })).toBe(
      false,
    );
  });
});

describe("analyzeNetworkPath", () => {
  it("matches a Service selector to backing pods and ready EndpointSlice endpoints", () => {
    const result = analyzeNetworkPath(baseSnapshot, {
      source: { kind: "Pod", namespace: "shop", name: "web-1" },
      destination: { kind: "Service", namespace: "shop", name: "api", port: 80 },
    });

    expect(result.service?.selectorMatched).toBe(true);
    expect(result.service?.backingPods.map((pod) => pod.name)).toEqual(["api-1", "api-2"]);
    expect(result.service?.readyEndpoints.map((endpoint) => endpoint.podName)).toEqual([
      "api-1",
    ]);
    expect(result.service?.diagnosis).toEqual("ready-endpoints");
  });

  it("resolves Service port and named targetPort against matching pods", () => {
    const result = analyzeNetworkPath(baseSnapshot, {
      source: { kind: "Pod", namespace: "shop", name: "web-1" },
      destination: { kind: "Service", namespace: "shop", name: "api", port: 80 },
    });

    expect(result.service?.portMappings).toEqual([
      {
        name: "http",
        protocol: "TCP",
        servicePort: 80,
        targetPort: "http",
        resolvedTargetPort: 8080,
      },
    ]);
  });

  it("diagnoses a Service whose selector matches no pods", () => {
    const snapshot: NetworkDebugSnapshot = {
      ...baseSnapshot,
      services: [
        {
          ...baseSnapshot.services[0],
          selector: { app: "missing" },
        },
      ],
      endpointSlices: [],
    };

    const result = analyzeNetworkPath(snapshot, {
      source: { kind: "Pod", namespace: "shop", name: "web-1" },
      destination: { kind: "Service", namespace: "shop", name: "api" },
    });

    expect(result.service?.selectorMatched).toBe(false);
    expect(result.service?.diagnosis).toEqual("selector-matches-no-pods");
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        title: "Service selector matches no pods",
      }),
    );
  });

  it("maps Ingress host and path rules to the selected Service", () => {
    const result = analyzeNetworkPath(baseSnapshot, {
      source: { kind: "Pod", namespace: "shop", name: "web-1" },
      destination: {
        kind: "Ingress",
        namespace: "shop",
        name: "shop",
        host: "shop.example.com",
        path: "/api/orders",
      },
    });

    expect(result.ingress?.matchedBackend).toEqual({
      ingressName: "shop",
      host: "shop.example.com",
      path: "/api",
      pathType: "Prefix",
      serviceName: "api",
      servicePort: "http",
    });
    expect(result.service?.service.name).toEqual("api");
  });

  it("marks ingress as likely allowed when a selected NetworkPolicy rule matches source pod labels and port", () => {
    const result = analyzeNetworkPath(
      {
        ...baseSnapshot,
        networkPolicies: [
          {
            name: "allow-web-to-api",
            namespace: "shop",
            podSelector: { app: "api" },
            policyTypes: ["Ingress"],
            ingress: [
              {
                from: [{ podSelector: { app: "web" } }],
                ports: [{ protocol: "TCP", port: 8080 }],
              },
            ],
          },
        ],
      },
      {
        source: { kind: "Pod", namespace: "shop", name: "web-1" },
        destination: { kind: "Service", namespace: "shop", name: "api", port: 80 },
      },
    );

    expect(result.networkPolicy?.verdict).toEqual("allowed");
    expect(result.networkPolicy?.policies.map((policy) => policy.name)).toEqual([
      "allow-web-to-api",
    ]);
  });

  it("marks ingress as likely blocked when NetworkPolicies isolate destination pods without a matching allow rule", () => {
    const result = analyzeNetworkPath(
      {
        ...baseSnapshot,
        networkPolicies: [
          {
            name: "deny-api",
            namespace: "shop",
            podSelector: { app: "api" },
            policyTypes: ["Ingress"],
            ingress: [],
          },
        ],
      },
      {
        source: { kind: "Pod", namespace: "shop", name: "web-1" },
        destination: { kind: "Service", namespace: "shop", name: "api", port: 80 },
      },
    );

    expect(result.networkPolicy?.verdict).toEqual("blocked");
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        title: "NetworkPolicy likely blocks ingress",
      }),
    );
  });
});
