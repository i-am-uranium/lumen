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
        title: "NetworkPolicy model blocks the path",
      }),
    );
  });
});

describe("bidirectional policy evidence", () => {
  const request = { source: { kind: "Pod" as const, namespace: "shop", name: "web-1" }, destination: { kind: "Service" as const, namespace: "shop", name: "api", port: 80 } };
  const verdict = (patch: Partial<NetworkDebugSnapshot>) => analyzeNetworkPath({ ...baseSnapshot, ...patch }, request).networkPolicy?.verdict;
  it("requires source egress even when destination ingress is unisolated", () => {
    expect(verdict({ networkPolicies: [{ name: "deny-egress", namespace: "shop", podSelector: { app: "web" }, policyTypes: ["Egress"], egress: [] }] })).toBe("blocked");
  });
  it("allows the union of rules within each isolated direction", () => {
    expect(verdict({ networkPolicies: [
      { name: "ingress", namespace: "shop", podSelector: { app: "api" }, ingress: [{ from: [{ podSelector: { app: "web" } }], ports: [{ port: "http" }] }] },
      { name: "egress", namespace: "shop", podSelector: { app: "web" }, policyTypes: ["Egress"], egress: [{ to: [{ podSelector: { app: "api" } }], ports: [{ port: 8080 }] }] },
    ] })).toBe("allowed");
  });
  it("preserves denied policy evidence instead of treating it as no policies", () => {
    expect(verdict({ unavailable: { "shop/networkPolicies": "403 Forbidden" } })).toBe("unknown");
  });
  it("does not drop unsupported selector expressions or IP blocks", () => {
    expect(verdict({ networkPolicies: [{ name: "expression", namespace: "shop", podSelector: {}, unsupported: true }] })).toBe("unknown");
    expect(verdict({ networkPolicies: [{ name: "ip", namespace: "shop", podSelector: { app: "api" }, ingress: [{ from: [{ ipBlock: { cidr: "10.0.0.0/8" } }] }] }] })).toBe("unknown");
  });
  it("resolves named ports independently for destination pods", () => {
    expect(verdict({ pods: baseSnapshot.pods.map(p => p.name === "api-2" ? { ...p, ports: [{ name: "http", containerPort: 9090 }] } : p), networkPolicies: [{ name: "numeric", namespace: "shop", podSelector: { app: "api" }, ingress: [{ ports: [{ port: 8080 }] }] }] })).toBe("unknown");
  });
  it("does not let an allowing policy for one pod allow another isolated pod", () => {
    expect(verdict({ pods: baseSnapshot.pods.map(p => ({ ...p, labels: { ...p.labels, instance: p.name } })), networkPolicies: [
      { name: "deny", namespace: "shop", podSelector: { app: "api" }, ingress: [] },
      { name: "allow-one", namespace: "shop", podSelector: { instance: "api-1" }, ingress: [{}] },
    ] })).toBe("unknown");
  });
  it("honors numeric ranges and protocol", () => {
    expect(verdict({ networkPolicies: [{ name: "range", namespace: "shop", podSelector: { app: "api" }, ingress: [{ ports: [{ port: 8000, endPort: 9000 }] }] }] })).toBe("allowed");
    expect(verdict({ networkPolicies: [{ name: "udp", namespace: "shop", podSelector: { app: "api" }, ingress: [{ ports: [{ port: 8080, protocol: "UDP" }] }] }] })).toBe("blocked");
  });
  it("supports cross-namespace AND namespace/pod selectors, including empty namespaceSelector", () => {
    const pods = baseSnapshot.pods.map(p => p.name === "web-1" ? { ...p, namespace: "client" } : p);
    const snapshot = { ...baseSnapshot, pods, namespaces: [...baseSnapshot.namespaces, { name: "client", labels: { team: "client" } }], networkPolicies: [{ name: "cross", namespace: "shop", podSelector: { app: "api" }, ingress: [{ from: [{ namespaceSelector: {}, podSelector: { app: "web" } }] }] }] };
    const req = { ...request, source: { ...request.source, namespace: "client" } };
    expect(analyzeNetworkPath(snapshot, req).networkPolicy?.verdict).toBe("allowed");
    snapshot.networkPolicies[0].ingress[0].from[0].podSelector.app = "other";
    expect(analyzeNetworkPath(snapshot, req).networkPolicy?.verdict).toBe("blocked");
  });
  it("does not assume empty namespace selector means same namespace", () => {
    const snapshot = { ...baseSnapshot, namespaces: [], networkPolicies: [{ name: "cross", namespace: "shop", podSelector: { app: "api" }, ingress: [{ from: [{ namespaceSelector: {} }] }] }] };
    expect(analyzeNetworkPath(snapshot, request).networkPolicy?.verdict).toBe("unknown");
  });
  it("retains healthy configuration with explicit unknown external connectivity", () => {
    expect(analyzeNetworkPath(baseSnapshot, request).findings).toContainEqual(expect.objectContaining({ title: "Connectivity remains unknown" }));
  });
  it("uses Pod destination ports and never guesses a missing source", () => {
    const snapshot = { ...baseSnapshot, networkPolicies: [{ name: "port", namespace: "shop", podSelector: { app: "api" }, ingress: [{ ports: [{ port: 8080 }] }] }] };
    expect(analyzeNetworkPath(snapshot, { ...request, destination: { kind: "Pod", namespace: "shop", name: "api-1", port: 9000 } }).networkPolicy?.verdict).toBe("blocked");
    expect(analyzeNetworkPath(snapshot, { destination: request.destination }).networkPolicy?.verdict).toBe("unknown");
  });
  it("does not diagnose absent endpoints when both endpoint reads failed", () => {
    const result = analyzeNetworkPath({ ...baseSnapshot, endpointSlices: [], unavailable: { "shop/endpointSlices": "403", "shop/endpoints": "403" } }, request);
    expect(result.service?.diagnosis).toBe("evidence-unavailable");
    expect(result.findings.some(f => f.title === "Service has no endpoints")).toBe(false);
  });
});
