import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkDebuggerView } from "./NetworkDebuggerView";
import { k8s } from "@/lib/k8s";
import type { NetworkDebugSnapshot } from "@/lib/networkDebugger";
vi.mock("@/components/ResourceDetailDrawer", () => ({ ResourceDetailDrawer: () => null }));
vi.mock("@/lib/k8s", () => ({ k8s: { listNamespaces: vi.fn(), networkDebugSnapshot: vi.fn() } }));
function snapshot(namespace: string): NetworkDebugSnapshot {
  return { loadedNamespaces: [namespace], namespaces: [{ name: namespace, labels: {} }], pods: [{ namespace, name: "pod", labels: { app: "api" }, ready: true, ports: [] }], services: [{ namespace, name: "api", selector: { app: "api" }, ports: [{ port: 80 }] }], endpoints: [], endpointSlices: [], ingresses: [], networkPolicies: [] };
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/cluster/test/network?ns=shop"]}><Routes><Route path="/cluster/:ctx/network" element={<NetworkDebuggerView />} /></Routes></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(k8s.listNamespaces).mockResolvedValue(["shop", "client"]);
  vi.mocked(k8s.networkDebugSnapshot).mockImplementation(async ns => snapshot(ns));
});
describe("NetworkDebuggerView", () => {
  it("loads source and target independently and labels inferred connectivity", async () => {
    setup();
    await screen.findByText("Connectivity remains unknown");
    fireEvent.change(screen.getByLabelText("source namespace"), { target: { value: "client" } });
    await waitFor(() => expect(k8s.networkDebugSnapshot).toHaveBeenCalledWith("client", "test"));
    expect(screen.getByLabelText("target namespace")).toHaveValue("shop");
    await screen.findByText("allowed-by-model");
  });
  it("keeps target evidence when source permission is denied", async () => {
    vi.mocked(k8s.networkDebugSnapshot).mockImplementation(async ns => { if (ns === "client") throw new Error("403 Forbidden"); return snapshot(ns); });
    setup();
    await screen.findByText("Connectivity remains unknown");
    fireEvent.change(screen.getByLabelText("source namespace"), { target: { value: "client" } });
    await screen.findAllByText(/Error: 403 Forbidden/);
    expect(screen.getByText("service route")).toBeInTheDocument();
    expect(screen.getByText("unknown", { selector: "h2" })).toBeInTheDocument();
  });
  it("shows Gateway evidence when pod and Service permissions are absent", async () => {
    const data = snapshot("shop");
    data.pods = []; data.services = [];
    data.unavailable = { "shop/pods": "403 Forbidden", "shop/services": "403 Forbidden" };
    data.gatewayResources = [{ kind: "HTTPRoute", metadata: { name: "route", namespace: "shop" }, spec: {} }];
    vi.mocked(k8s.networkDebugSnapshot).mockResolvedValue(data);
    setup();
    await screen.findByText("Gateway request-path evidence");
    expect(screen.getByText(/Evidence unavailable: shop\/pods/)).toBeInTheDocument();
  });
  it("invalidates source policy certainty when a refetch fails with cached data", async () => {
    setup();
    await screen.findByText("Connectivity remains unknown");
    fireEvent.change(screen.getByLabelText("source namespace"), { target: { value: "client" } });
    await screen.findByText("allowed-by-model");
    await waitFor(() => expect(k8s.networkDebugSnapshot).toHaveBeenCalledWith("client", "test"));
    vi.mocked(k8s.networkDebugSnapshot).mockImplementation(async ns => { if (ns === "client") throw new Error("403 refreshed"); return snapshot(ns); });
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    await screen.findAllByText(/Error: 403 refreshed/);
    expect(screen.getByText("unknown", { selector: "h2" })).toBeInTheDocument();
  });

});

it("drops stale source Gateway, backend and grant conclusions after its refresh fails", async () => {
  const target = snapshot("shop");
  target.gatewayResources = [{ kind: "HTTPRoute", metadata: { name: "route", namespace: "shop", generation: 1 }, spec: { parentRefs: [{ name: "edge", namespace: "client" }], rules: [{ backendRefs: [{ name: "api", namespace: "client", port: 80 }] }] } }];
  const source = snapshot("client");
  source.pods[0].ports = [{ name: "http", containerPort: 8080 }];
  source.services[0].ports = [{ name: "http", port: 80, targetPort: "http" }];
  source.endpointSlices = [{ name: "api-http", namespace: "client", serviceName: "api", ports: [{ name: "http", port: 8080 }], endpoints: [{ addresses: ["10.0.0.1"], ready: true, targetRef: { kind: "Pod", namespace: "client", name: "pod" } }] }];
  source.gatewayResources = [
    { kind: "Gateway", metadata: { name: "edge", namespace: "client", generation: 1 }, spec: { listeners: [{ name: "http", protocol: "HTTP", port: 80, allowedRoutes: { namespaces: { from: "All" } } }] }, status: { conditions: [{ type: "Programmed", status: "True", observedGeneration: 1 }] } },
    { kind: "ReferenceGrant", metadata: { name: "grant", namespace: "client" }, spec: { from: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute", namespace: "shop" }], to: [{ group: "", kind: "Service", name: "api" }] } },
  ];
  vi.mocked(k8s.networkDebugSnapshot).mockImplementation(async (ns) => ns === "client" ? source : target);
  setup(); await screen.findByText("Connectivity remains unknown");
  fireEvent.change(screen.getByLabelText("source namespace"), { target: { value: "client" } });
  const row = (title: string) => screen.getByText((content) => content.startsWith(`${title} · `)).closest("div.rounded-control")!;
  await waitFor(() => expect(row("HTTPRoute backend → Service → endpoints → pods")).toHaveTextContent("allowed-by-model"));
  expect(row("Gateway: Programmed")).toHaveTextContent("allowed-by-model");
  expect(row("Cross-namespace ReferenceGrant")).toHaveTextContent("allowed-by-model");
  vi.mocked(k8s.networkDebugSnapshot).mockImplementation(async (ns) => { if (ns === "client") throw new Error("source refresh denied"); return target; });
  fireEvent.click(screen.getByRole("button", { name: "refresh" }));
  await screen.findAllByText(/source refresh denied/);
  await waitFor(() => expect(screen.queryByText((content) => content.startsWith("Gateway: Programmed · "))).not.toBeInTheDocument());
  expect(row("Gateway parent missing")).toHaveTextContent("unknown");
  expect(row("Cross-namespace ReferenceGrant")).toHaveTextContent("unknown");
  expect(row("Backend Service missing")).toHaveTextContent("unknown");
  expect(screen.getByText(/Evidence unavailable: client\/gateways/)).toBeInTheDocument();
});
