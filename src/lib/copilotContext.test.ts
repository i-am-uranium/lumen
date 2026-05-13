import { describe, expect, it } from "vitest";
import {
  buildCopilotPromptContext,
  buildCopilotRouteContext,
} from "./copilotContext";

describe("copilot context", () => {
  it("labels known cluster routes", () => {
    expect(buildCopilotRouteContext("/cluster/ms-aks-stage/logs", "?ns=clinical")).toMatchObject({
      page: "logs",
      namespace: "clinical",
    });
    expect(buildCopilotRouteContext("/cluster/ms-aks-stage/alerts", "")).toMatchObject({
      page: "alert inbox",
    });
    expect(buildCopilotRouteContext("/cluster/ms-aks-stage/argocd", "?app=argocd%2Fdoctor-dashboard")).toMatchObject({
      page: "argocd",
      resource: "argocd/doctor-dashboard",
    });
  });

  it("builds concise prompt context", () => {
    expect(
      buildCopilotPromptContext({
        clusterContext: "ms-aks-stage",
        route: buildCopilotRouteContext("/cluster/ms-aks-stage/alerts", "?ns=clinical"),
        prompt: "why is customer-service noisy?",
      }),
    ).toContain("cluster: ms-aks-stage");
  });
});
