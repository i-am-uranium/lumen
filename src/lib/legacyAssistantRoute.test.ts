import { describe, expect, it } from "vitest";
import { legacyAssistantTarget } from "./legacyAssistantRoute";

describe("retired assistant navigation", () => {
  it("recovers the original cluster and resource focus in workloads", () => {
    expect(legacyAssistantTarget("prod/us east", { kind: "deployment", namespace: "payments", name: "api" }))
      .toBe("/cluster/prod%2Fus%20east/workloads?ns=payments&q=api");
  });
  it("preserves saved question and context references without executing them", () => {
    expect(legacyAssistantTarget("prod", { kind: "", name: "" }, "question=Why%3F&aiContext=saved-context"))
      .toBe("/cluster/prod/workloads?question=Why%3F&aiContext=saved-context");
  });
  it("recovers cluster-only tabs without empty filters", () => {
    expect(legacyAssistantTarget("prod", { kind: "", name: "" }))
      .toBe("/cluster/prod/workloads");
  });
});
