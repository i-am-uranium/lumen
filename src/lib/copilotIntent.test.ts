import { describe, expect, it } from "vitest";
import { classifyCopilotIntent } from "./copilotIntent";

describe("classifyCopilotIntent", () => {
  it("classifies latest logs requests and extracts target text", () => {
    expect(classifyCopilotIntent("show latest logs from customer service")).toMatchObject({
      kind: "logs",
      targetText: "customer service",
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

  it("falls back to investigation for unknown questions", () => {
    expect(classifyCopilotIntent("why is this failing")).toMatchObject({
      kind: "investigate",
    });
  });
});
