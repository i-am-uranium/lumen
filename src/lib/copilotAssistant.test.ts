import { describe, expect, it, vi } from "vitest";
import type { EventSummary, WorkloadKind, WorkloadSummary } from "@/lib/k8s";
import { buildCopilotResponse, buildNativeCopilotResponse } from "./copilotAssistant";

function workload(
  name: string,
  namespace = "checkout",
  kind: WorkloadKind = "deployment",
  overrides: Partial<WorkloadSummary> = {},
): WorkloadSummary {
  return {
    kind,
    name,
    namespace,
    ready: "2/2",
    age_seconds: 120,
    health: "healthy",
    labels: {},
    ...overrides,
  };
}

function event(reason: string): EventSummary {
  return {
    ts: "2026-05-10T00:00:00Z",
    type_: "Warning",
    reason,
    message: `${reason} on customer-service`,
    involved_kind: "Pod",
    involved_name: "customer-service-7f9d",
    count: 1,
  };
}

function resolverClient(items: WorkloadSummary[]) {
  return {
    listWorkloads: vi.fn(async (_namespace: string, kind: WorkloadKind) =>
      items.filter((item) => item.kind === kind),
    ),
  };
}

const route = {
  page: "AI assistant",
  namespace: "",
  resource: "",
  path: "/cluster/ms-aks-stage/ai",
  search: "",
};

describe("buildCopilotResponse", () => {
  it("turns a latest logs request into a read-only logs CTA", () => {
    const response = buildCopilotResponse({
      prompt: "fetch customer service logs",
      clusterContext: "ms-aks-stage",
      route: {
        page: "logs",
        namespace: "checkout",
        resource: "",
        path: "/cluster/ms-aks-stage/logs",
        search: "?ns=checkout",
      },
    });

    expect(response.title).toBe("Open logs for customer service");
    expect(response.ctas[0]).toMatchObject({
      label: "Open logs",
      to: "/cluster/ms-aks-stage/logs?ns=checkout&kind=deployment&name=customer-service&grep=customer+service",
    });
    expect(response.commands.join("\n")).toContain("--tail=200");
  });

  it("includes a likely workload target when namespace is unknown", () => {
    const response = buildCopilotResponse({
      prompt: "fetch customer service logs",
      clusterContext: "ms-aks-stage",
      route: {
        page: "AI assistant",
        namespace: "",
        resource: "",
        path: "/cluster/ms-aks-stage/ai",
        search: "",
      },
    });

    expect(response.ctas[0]).toMatchObject({
      label: "Open logs",
      to: "/cluster/ms-aks-stage/logs?kind=deployment&name=customer-service&grep=customer+service",
    });
  });

  it("routes a natural-language sync request to ArgoCD without performing the sync", () => {
    const response = buildCopilotResponse({
      prompt: "I deployed the doctor dashboard, please sync",
      clusterContext: "ms-aks-stage",
      route: {
        page: "argocd",
        namespace: "",
        resource: "",
        path: "/cluster/ms-aks-stage/argocd",
        search: "",
      },
    });

    expect(response.title).toBe("Review doctor dashboard in ArgoCD");
    expect(response.summary).toMatch(/I will not run sync/i);
    expect(response.ctas[0]).toMatchObject({
      label: "Open ArgoCD app",
      to: "/cluster/ms-aks-stage/argocd?app=argocd%2Fdoctor-dashboard",
    });
  });
});

describe("buildNativeCopilotResponse", () => {
  it("resolves logs requests before returning a Logs CTA", async () => {
    const response = await buildNativeCopilotResponse(
      {
        prompt: "fetch customer service logs",
        clusterContext: "ms-aks-stage",
        route,
      },
      {
        resolver: resolverClient([workload("customer-service", "checkout")]),
        evidence: {
          listPodsFor: vi.fn(async () => [workload("customer-service-7f9d", "checkout", "pod")]),
          listEventsFor: vi.fn(async () => []),
        },
      },
    );

    expect(response).toMatchObject({
      mode: "resolved",
      title: "Found deployment/customer-service",
      target: {
        namespace: "checkout",
        name: "customer-service",
      },
    });
    expect(response.ctas[0]).toMatchObject({
      label: "Open logs for customer-service",
      to: "/cluster/ms-aks-stage/logs?ns=checkout&kind=deployment&name=customer-service&grep=customer-service",
    });
  });

  it("resolves polite latest-log requests without treating filler words as the target", async () => {
    const response = await buildNativeCopilotResponse(
      {
        prompt: "fetch me the latest logs of oaut-service",
        clusterContext: "ms-aks-stage",
        route,
      },
      {
        resolver: resolverClient([workload("oaut-service", "identity")]),
        evidence: {
          listPodsFor: vi.fn(async () => [workload("oaut-service-7f9d", "identity", "pod")]),
          listEventsFor: vi.fn(async () => []),
        },
      },
    );

    expect(response).toMatchObject({
      mode: "resolved",
      title: "Found deployment/oaut-service",
      target: {
        namespace: "identity",
        name: "oaut-service",
      },
    });
    expect(response.ctas[0]).toMatchObject({
      to: "/cluster/ms-aks-stage/logs?ns=identity&kind=deployment&name=oaut-service&grep=oaut-service",
    });
  });

  it("returns evidence-backed investigation responses", async () => {
    const response = await buildNativeCopilotResponse(
      {
        prompt: "why is customer service failing",
        clusterContext: "ms-aks-stage",
        route,
      },
      {
        resolver: resolverClient([workload("customer-service", "checkout")]),
        evidence: {
          listPodsFor: vi.fn(async () => [
            workload("customer-service-7f9d", "checkout", "pod", {
              health: "degraded",
              ready: "0/1",
              restart_count: 4,
            }),
          ]),
          listEventsFor: vi.fn(async () => [event("BackOff")]),
        },
      },
    );

    expect(response.mode).toBe("resolved");
    expect(response.evidence?.health).toBe("degraded");
    expect(response.summary).toContain("BackOff");
  });

  it("returns candidate choices for ambiguous resource matches", async () => {
    const response = await buildNativeCopilotResponse(
      {
        prompt: "fetch customer service logs",
        clusterContext: "ms-aks-stage",
        route,
      },
      {
        resolver: resolverClient([
          workload("customer-service", "checkout"),
          workload("customer-service", "payments"),
        ]),
      },
    );

    expect(response.mode).toBe("ambiguous");
    expect(response.candidates?.map((candidate) => candidate.namespace)).toEqual([
      "checkout",
      "payments",
    ]);
    expect(response.ctas).toEqual([]);
  });

  it("treats mutation requests as read-only handoffs", async () => {
    const response = await buildNativeCopilotResponse(
      {
        prompt: "restart customer service",
        clusterContext: "ms-aks-stage",
        route,
      },
      {
        resolver: resolverClient([workload("customer-service", "checkout")]),
        evidence: {
          listPodsFor: vi.fn(async () => []),
          listEventsFor: vi.fn(async () => []),
        },
      },
    );

    expect(response.mode).toBe("handoff");
    expect(response.summary).toMatch(/cannot restart/i);
    expect(response.ctas.every((cta) => cta.readOnly)).toBe(true);
  });
});
