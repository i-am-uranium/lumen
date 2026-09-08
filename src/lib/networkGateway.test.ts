import { describe, expect, it } from "vitest";
import { analyzeGatewayRelationships, type GatewayObject } from "./networkGateway";
import type { NetworkDebugSnapshot } from "./networkDebugger";
const conditions = ["Accepted", "ResolvedRefs", "Programmed"].map(type => ({ type, status: "True", observedGeneration: 2 }));
const gateway: GatewayObject = { kind: "Gateway", metadata: { name: "edge", namespace: "web", generation: 2 }, spec: { listeners: [{ name: "http", protocol: "HTTP", port: 80 }] }, status: { conditions, listeners: [{ name: "http", conditions }] } };
const route: GatewayObject = { kind: "HTTPRoute", metadata: { name: "route", namespace: "web", generation: 2 }, spec: { parentRefs: [{ name: "edge", sectionName: "http" }], rules: [{ backendRefs: [{ name: "api", port: 80 }] }] }, status: { parents: [{ parentRef: { name: "edge", sectionName: "http" }, conditions }] } };
const snapshot = (resources: GatewayObject[]): NetworkDebugSnapshot => ({ loadedNamespaces: ["web"], namespaces: [], pods: [], services: [], endpoints: [], endpointSlices: [], ingresses: [], networkPolicies: [], gatewayResources: resources });
describe("Gateway relationship evidence", () => {
  it("relates the exact listener and route parent while keeping connectivity unknown", () => {
    const result = analyzeGatewayRelationships(snapshot([gateway, route]));
    expect(result).toContainEqual(expect.objectContaining({ title: "Listener http → HTTPRoute", outcome: "allowed-by-model" }));
    expect(result).toContainEqual(expect.objectContaining({ title: "HTTPRoute request selection", outcome: "unknown" }));
    expect(result).toContainEqual(expect.objectContaining({ title: "Backend Service missing", outcome: "blocked" }));
  });
  it("does not use another parent listener's healthy status", () => {
    const other = structuredClone(route); other.status!.parents![0].parentRef.sectionName = "other";
    expect(analyzeGatewayRelationships(snapshot([gateway, other]))).toContainEqual(expect.objectContaining({ title: "HTTPRoute parent: Accepted", outcome: "unknown" }));
  });
  it("marks stale generation and missing listeners explicitly", () => {
    const stale = structuredClone(gateway); stale.metadata.generation = 3;
    const other = structuredClone(route); other.spec!.parentRefs![0].sectionName = "missing";
    const result = analyzeGatewayRelationships(snapshot([stale, other]));
    expect(result).toContainEqual(expect.objectContaining({ title: "Gateway: Programmed", outcome: "unknown" }));
    expect(result).toContainEqual(expect.objectContaining({ title: "Gateway listener missing", outcome: "blocked" }));
  });
  it("enforces allowedRoutes namespace restrictions", () => {
    const cross = structuredClone(route); cross.metadata.namespace = "client"; cross.spec!.parentRefs![0].namespace = "web";
    expect(analyzeGatewayRelationships(snapshot([gateway, cross]))).toContainEqual(expect.objectContaining({ title: "Listener http → HTTPRoute", outcome: "blocked" }));
  });
  it("requires a ReferenceGrant matching source group/kind/namespace and backend name", () => {
    const cross = structuredClone(route); cross.spec!.rules![0].backendRefs![0].namespace = "api";
    const data = snapshot([gateway, cross]); data.loadedNamespaces!.push("api");
    expect(analyzeGatewayRelationships(data)).toContainEqual(expect.objectContaining({ title: "Cross-namespace ReferenceGrant", outcome: "blocked" }));
    data.gatewayResources!.push({ kind: "ReferenceGrant", metadata: { name: "grant", namespace: "api" }, spec: { from: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute", namespace: "web" }], to: [{ group: "", kind: "Service", name: "other" }] } });
    expect(analyzeGatewayRelationships(data)).toContainEqual(expect.objectContaining({ title: "Cross-namespace ReferenceGrant", outcome: "blocked" }));
    data.gatewayResources![2].spec!.to![0].name = "api";
    expect(analyzeGatewayRelationships(data)).toContainEqual(expect.objectContaining({ title: "Cross-namespace ReferenceGrant", outcome: "allowed-by-model" }));
  });
  it("keeps denied and unloaded references unknown rather than absent", () => {
    const data = snapshot([route]); data.unavailable = { "web/gateways": "403" };
    expect(analyzeGatewayRelationships(data)).toContainEqual(expect.objectContaining({ title: "Gateway parent missing", outcome: "unknown" }));
  });
  it("explains healthy backend objects without proving connectivity", () => {
    const data = snapshot([gateway, route]);
    data.pods = [{ name: "api-1", namespace: "web", labels: { app: "api" }, ready: true, ports: [{ name: "http", containerPort: 8080 }] }];
    data.services = [{ name: "api", namespace: "web", selector: { app: "api" }, ports: [{ name: "http", port: 80, targetPort: "http" }] }];
    data.endpointSlices = [{ name: "api-slice", namespace: "web", serviceName: "api", ports: [{ name: "http", protocol: "TCP", port: 8080 }], endpoints: [{ ready: true, addresses: ["10.0.0.1"], targetRef: { kind: "Pod", name: "api-1" } }] }];
    expect(analyzeGatewayRelationships(data)).toContainEqual(expect.objectContaining({ title: "HTTPRoute backend → Service → endpoints → pods", outcome: "allowed-by-model", objects: expect.arrayContaining([expect.objectContaining({ kind: "EndpointSlice", name: "api-slice" }), expect.objectContaining({ kind: "Pod", name: "api-1" })]) }));
  });
  it("blocks listener hostname mismatch", () => {
    const hostGateway = structuredClone(gateway); hostGateway.spec!.listeners![0].hostname = "*.example.com";
    const hostRoute = structuredClone(route); hostRoute.spec!.hostnames = ["other.test"];
    expect(analyzeGatewayRelationships(snapshot([hostGateway, hostRoute]))).toContainEqual(expect.objectContaining({ title: "Listener http → HTTPRoute", outcome: "blocked" }));
  });

});

function backendSnapshot(): NetworkDebugSnapshot {
  const data = snapshot([gateway, route]);
  data.pods = [
    { name: "api-a", namespace: "web", labels: { app: "api" }, ready: true, ports: [{ name: "http", containerPort: 8080 }, { name: "metrics", containerPort: 9090 }] },
    { name: "api-b", namespace: "web", labels: { app: "api" }, ready: true, ports: [{ name: "http", containerPort: 8081 }, { name: "metrics", containerPort: 9090 }] },
  ];
  data.services = [{ name: "api", namespace: "web", selector: { app: "api" }, ports: [{ name: "http", port: 80, targetPort: "http" }, { name: "metrics", port: 9090, targetPort: "metrics" }] }];
  data.endpointSlices = [{ name: "metrics-only", namespace: "web", serviceName: "api", ports: [{ name: "metrics", protocol: "TCP", port: 9090 }], endpoints: [{ ready: true, addresses: ["10.0.0.1"], targetRef: { kind: "Pod", namespace: "web", name: "api-a" } }] }];
  return data;
}
const backendRow = (data: NetworkDebugSnapshot) => analyzeGatewayRelationships(data).find((row) => row.title === "HTTPRoute backend → Service → endpoints → pods")!;
describe("review regressions: selected backend endpoint evidence", () => {
  it("cannot use metrics-only endpoints to establish an HTTP backend", () => {
    const result = backendRow(backendSnapshot());
    expect(result.outcome).toBe("unknown");
    expect(result.objects.some((ref) => ref.kind === "Pod")).toBe(false);
  });
  it("resolves named targets per slice and cites only namespace-qualified endpoint pods", () => {
    const data = backendSnapshot();
    data.endpointSlices.push(
      { name: "http-a", namespace: "web", serviceName: "api", ports: [{ name: "http", port: 8080 }], endpoints: [{ ready: true, addresses: ["10.0.0.1"], targetRef: { kind: "Pod", namespace: "web", name: "api-a" } }] },
      { name: "http-b", namespace: "web", serviceName: "api", ports: [{ name: "http", port: 8081 }], endpoints: [{ ready: true, addresses: ["10.0.0.2"], targetRef: { kind: "Pod", namespace: "web", name: "api-b" } }] },
    );
    expect(backendRow(data)).toMatchObject({ outcome: "allowed-by-model", objects: expect.arrayContaining([{ kind: "Pod", namespace: "web", name: "api-a" }, { kind: "Pod", namespace: "web", name: "api-b" }]) });
    expect(backendRow(data).objects.some((ref) => ref.name === "metrics-only")).toBe(false);
    data.endpointSlices[2].ports[0].port = 8080;
    expect(backendRow(data).outcome).toBe("unknown");
    expect(backendRow(data).objects.some((ref) => ref.kind === "Pod" && ref.name === "api-b")).toBe(false);
  });
  it.each(["wrong-protocol", "wrong-namespace", "legacy", "slice-denied", "endpoints-denied"])("does not assert a supported chain with %s evidence", (variant) => {
    const data = backendSnapshot();
    data.endpointSlices[0].ports = [{ name: "http", protocol: "TCP", port: 8080 }];
    if (variant === "wrong-protocol") data.endpointSlices[0].ports[0].protocol = "UDP";
    if (variant === "wrong-namespace") data.endpointSlices[0].endpoints[0].targetRef!.namespace = "other";
    if (variant === "legacy") { data.endpoints = [{ name: "api", namespace: "web", addresses: data.endpointSlices[0].endpoints }]; data.endpointSlices = []; }
    if (variant === "slice-denied" || variant === "endpoints-denied") { data.endpointSlices = []; data.unavailable = { [`web/${variant === "slice-denied" ? "endpointSlices" : "endpoints"}`]: "403" }; }
    expect(backendRow(data).outcome).toBe("unknown");
    expect(backendRow(data).objects.some((ref) => ref.kind === "Pod")).toBe(false);
  });
});

it("keeps positive matching EndpointSlice evidence when only legacy Endpoints are unreadable", () => {
  const data = backendSnapshot();
  data.endpointSlices[0].ports = [{ name: "http", port: 8080 }];
  data.unavailable = { "web/endpoints": "403" };
  expect(backendRow(data).outcome).toBe("allowed-by-model");
});
