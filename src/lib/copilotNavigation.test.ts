import { describe, expect, it } from "vitest";
import {
  buildArgocdAppCta,
  buildLogsCta,
  buildLogsSearchCta,
  type CopilotResolvedTarget,
} from "./copilotNavigation";

const target: CopilotResolvedTarget = {
  kind: "deployment",
  namespace: "clinical",
  name: "customer-service",
};

describe("copilot navigation", () => {
  it("builds read-only logs CTAs with resource filters", () => {
    expect(buildLogsCta("ms-aks-stage", target)).toEqual({
      id: "open-logs",
      label: "Open logs filtered to customer-service",
      description: "Navigate to Logs with context, namespace, kind, and name prefilled.",
      to: "/cluster/ms-aks-stage/logs?ns=clinical&kind=deployment&name=customer-service",
      intent: "logs",
      readOnly: true,
    });
  });

  it("builds read-only ArgoCD app CTAs", () => {
    expect(
      buildArgocdAppCta("ms-aks-stage", {
        kind: "application",
        namespace: "argocd",
        name: "doctor-dashboard",
      }),
    ).toMatchObject({
      id: "open-argocd-app",
      label: "Open doctor-dashboard in ArgoCD",
      to: "/cluster/ms-aks-stage/argocd?app=argocd%2Fdoctor-dashboard",
      readOnly: true,
    });
  });

  it("builds fallback log search CTAs", () => {
    expect(buildLogsSearchCta("ms-aks-stage", "customer service", "clinical")).toMatchObject({
      id: "search-logs",
      label: "Search logs for customer service",
      to: "/cluster/ms-aks-stage/logs?ns=clinical&grep=customer+service",
      readOnly: true,
    });
  });
});
