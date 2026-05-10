import { describe, expect, it, vi } from "vitest";
import { classifyCopilotIntentWithModel } from "./copilotLlmIntent";

const route = {
  page: "logs",
  namespace: "",
  resource: "",
  path: "/cluster/ms-aks-stage/logs",
  search: "",
};

describe("classifyCopilotIntentWithModel", () => {
  it("uses model JSON to understand a natural log request", async () => {
    const runPrompt = vi.fn(async () => ({
      provider: "codex",
      stdout: JSON.stringify({
        kind: "logs",
        targetText: "oaut-service",
        requestedAction: "open",
      }),
      stderr: "",
      exit_code: 0,
      timed_out: false,
    }));

    const intent = await classifyCopilotIntentWithModel(
      {
        prompt: "fetch me the latest logs of oaut-service",
        clusterContext: "ms-aks-stage",
        route,
        provider: "codex",
        model: "gpt-5.2",
        instructions: "Prefer exact Kubernetes workload names.",
      },
      { runPrompt },
    );

    expect(intent).toMatchObject({
      kind: "logs",
      targetText: "oaut-service",
      requestedAction: "open",
    });
    expect(runPrompt).toHaveBeenCalledWith(
      "codex",
      expect.stringContaining("Return only compact JSON"),
      "gpt-5.2",
    );
  });

  it("falls back to local intent parsing when the model output is unusable", async () => {
    const intent = await classifyCopilotIntentWithModel(
      {
        prompt: "fetch me the latest logs of oaut-service",
        clusterContext: "ms-aks-stage",
        route,
        provider: "claude",
        model: "sonnet",
        instructions: "",
      },
      {
        runPrompt: vi.fn(async () => ({
          provider: "claude",
          stdout: "I would open logs.",
          stderr: "",
          exit_code: 0,
          timed_out: false,
        })),
      },
    );

    expect(intent).toMatchObject({
      kind: "logs",
      targetText: "oaut-service",
      requestedAction: "open",
    });
  });
});
