import { describe, expect, it } from "vitest";
import { buildCopilotResponse } from "./copilotAssistant";

describe("buildCopilotResponse", () => {
  it("turns a latest logs request into a read-only logs CTA", () => {
    const response = buildCopilotResponse({
      prompt: "show latest logs from customer service",
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
      to: "/cluster/ms-aks-stage/logs?ns=checkout&grep=customer+service",
    });
    expect(response.commands.join("\n")).toContain("--tail=200");
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
