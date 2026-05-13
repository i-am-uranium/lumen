import { describe, expect, it, vi } from "vitest";
import type { WorkloadKind, WorkloadSummary } from "@/lib/k8s";
import {
  normalizeCopilotResourcePhrase,
  resolveCopilotResource,
  scoreCopilotCandidate,
} from "./copilotResourceResolver";

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

function client(items: WorkloadSummary[]) {
  return {
    listWorkloads: vi.fn(async (_namespace: string, kind: WorkloadKind) =>
      items.filter((item) => item.kind === kind),
    ),
    listArgocdApplications: vi.fn(async () => []),
    listHelmReleases: vi.fn(async () => []),
  };
}

describe("copilot resource resolver", () => {
  it("normalizes natural language resource phrases", () => {
    expect(normalizeCopilotResourcePhrase("customer service")).toBe("customer-service");
    expect(normalizeCopilotResourcePhrase("Customer_Service API")).toBe("customer-service-api");
  });

  it("scores exact normalized name matches higher than partial matches", () => {
    const exact = scoreCopilotCandidate("customer service", workload("customer-service"));
    const partial = scoreCopilotCandidate("customer service", workload("customer-api"));

    expect(exact).toMatchObject({ score: 100 });
    expect(exact.reasons).toContain("exact normalized name match");
    expect(partial.score).toBeLessThan(exact.score);
  });

  it("resolves one exact deployment across namespaces", async () => {
    const fake = client([workload("customer-service", "checkout")]);

    const result = await resolveCopilotResource(
      { context: "stage", query: "customer service", kinds: ["deployment"] },
      fake,
    );

    expect(fake.listWorkloads).toHaveBeenCalledWith("", "deployment", "stage");
    expect(result).toMatchObject({
      status: "resolved",
      normalizedQuery: "customer-service",
      selected: {
        kind: "deployment",
        namespace: "checkout",
        name: "customer-service",
        score: 100,
      },
    });
  });

  it("marks multiple exact matches as ambiguous when namespace is missing", async () => {
    const fake = client([
      workload("customer-service", "checkout"),
      workload("customer-service", "payments"),
    ]);

    const result = await resolveCopilotResource(
      { context: "stage", query: "customer service", kinds: ["deployment"] },
      fake,
    );

    expect(result.status).toBe("ambiguous");
    expect(result.selected).toBeNull();
    expect(result.candidates.map((candidate) => candidate.namespace)).toEqual([
      "checkout",
      "payments",
    ]);
  });

  it("prefers an exact match in the current namespace", async () => {
    const fake = client([
      workload("customer-service", "checkout"),
      workload("customer-service", "payments"),
    ]);

    const result = await resolveCopilotResource(
      {
        context: "stage",
        query: "customer service",
        namespace: "payments",
        kinds: ["deployment"],
      },
      fake,
    );

    expect(fake.listWorkloads).toHaveBeenCalledWith("payments", "deployment", "stage");
    expect(result).toMatchObject({
      status: "resolved",
      selected: {
        namespace: "payments",
        name: "customer-service",
      },
    });
  });

  it("returns not_found when no candidate clears the score threshold", async () => {
    const fake = client([workload("billing-worker", "payments")]);

    const result = await resolveCopilotResource(
      { context: "stage", query: "customer service", kinds: ["deployment"] },
      fake,
    );

    expect(result).toMatchObject({
      status: "not_found",
      selected: null,
      searchedKinds: ["deployment"],
    });
    expect(result.candidates).toEqual([]);
  });
});
