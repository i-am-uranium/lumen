import { describe, expect, it } from "vitest";
import { classifyCopilotIntent } from "./copilotIntent";

describe("classifyCopilotIntent", () => {
  it("classifies latest logs requests and extracts target text", () => {
    expect(classifyCopilotIntent("show latest logs from customer service")).toMatchObject({
      kind: "logs",
      targetText: "customer service",
    });
    expect(classifyCopilotIntent("fetch customer service logs")).toMatchObject({
      kind: "logs",
      targetText: "customer service",
    });
    expect(classifyCopilotIntent("fetch me the latest logs of oaut-service")).toMatchObject({
      kind: "logs",
      targetText: "oaut-service",
    });
  });

  it("classifies sync requests as read-only ArgoCD navigation intents", () => {
    expect(classifyCopilotIntent("I deployed the doctor dashboard, please sync")).toMatchObject({
      kind: "argocd-app",
      targetText: "doctor dashboard",
      requestedAction: "sync",
    });
  });

  it("classifies incident update requests", () => {
    expect(classifyCopilotIntent("draft an incident update for this alert")).toMatchObject({
      kind: "incident-update",
    });
  });

  it("extracts investigation targets from failure questions", () => {
    expect(classifyCopilotIntent("why is customer service failing")).toMatchObject({
      kind: "investigate",
      targetText: "customer service",
    });
  });

  it("classifies mutation requests as read-only handoff intents", () => {
    expect(classifyCopilotIntent("restart customer service")).toMatchObject({
      kind: "mutation-request",
      targetText: "customer service",
      requestedAction: "mutate",
    });
  });

  it("falls back to investigation for unknown questions", () => {
    expect(classifyCopilotIntent("why is this failing")).toMatchObject({
      kind: "investigate",
    });
  });
});
