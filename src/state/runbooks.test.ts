import { beforeEach, describe, expect, it } from "vitest";
import {
  RUNBOOKS_STORAGE_KEY,
  buildRunbookStepUrl,
  validateRunbookInput,
  useRunbooksStore,
  type RunbookInput,
} from "./runbooks";

const runbook: RunbookInput = {
  name: "Deployment rollback check",
  description: "Walk the operator through the safe triage flow.",
  steps: [
    {
      id: "step-route",
      kind: "open-route",
      title: "Open workloads",
      route: "workloads/deployments?ns=payments&q=api",
    },
    {
      id: "step-resource",
      kind: "open-resource",
      title: "Open API deployment",
      resource: {
        kind: "deployment",
        namespace: "payments",
        name: "api",
      },
    },
    {
      id: "step-logs",
      kind: "open-logs",
      title: "Open error logs",
      logs: {
        namespace: "payments",
        kind: "deployment",
        name: "api",
        filter: "panic",
      },
    },
    {
      id: "step-manual",
      kind: "checklist",
      title: "Confirm owner",
      note: "Verify the owning team is online before action.",
    },
  ],
};

beforeEach(() => {
  window.localStorage.clear();
  useRunbooksStore.getState().reset();
});

describe("runbooks store", () => {
  it("validates names and structured step requirements", () => {
    expect(validateRunbookInput({ ...runbook, name: "" })).toContain(
      "Name is required.",
    );
    expect(validateRunbookInput({ ...runbook, steps: [] })).toContain(
      "At least one step is required.",
    );
    expect(
      validateRunbookInput({
        ...runbook,
        steps: [{ id: "bad", kind: "open-resource", title: "Missing resource" }],
      }),
    ).toContain("Step 1 needs a resource target.");
    expect(validateRunbookInput(runbook)).toEqual([]);
  });

  it("adds, updates, deletes, and persists runbooks", () => {
    const saved = useRunbooksStore.getState().addRunbook(runbook, 2_000);
    expect(saved.steps).toHaveLength(4);
    expect(saved.createdAt).toBe(2_000);
    expect(
      JSON.parse(window.localStorage.getItem(RUNBOOKS_STORAGE_KEY) ?? "[]"),
    ).toHaveLength(1);

    useRunbooksStore
      .getState()
      .updateRunbook(saved.id, { description: "Updated" }, 2_500);
    expect(useRunbooksStore.getState().runbooks[0]).toMatchObject({
      description: "Updated",
      createdAt: 2_000,
      updatedAt: 2_500,
    });

    useRunbooksStore.getState().deleteRunbook(saved.id);
    expect(useRunbooksStore.getState().runbooks).toEqual([]);
    expect(window.localStorage.getItem(RUNBOOKS_STORAGE_KEY)).toBe("[]");
  });

  it("tracks step-by-step completion state locally", () => {
    const saved = useRunbooksStore.getState().addRunbook(runbook, 2_000);

    useRunbooksStore.getState().startRunbook(saved.id);
    expect(useRunbooksStore.getState().activeRun).toEqual({
      runbookId: saved.id,
      currentStepId: "step-route",
      completedStepIds: [],
    });

    useRunbooksStore.getState().completeStep("step-route");
    expect(useRunbooksStore.getState().activeRun).toEqual({
      runbookId: saved.id,
      currentStepId: "step-resource",
      completedStepIds: ["step-route"],
    });

    useRunbooksStore.getState().resetRun();
    expect(useRunbooksStore.getState().activeRun).toBeNull();
  });

  it("builds safe step URLs for route, resource, logs, and AI steps", () => {
    expect(buildRunbookStepUrl(runbook.steps[0], "prod/us-east")).toBe(
      "/cluster/prod%2Fus-east/workloads/deployments?ns=payments&q=api",
    );
    expect(buildRunbookStepUrl(runbook.steps[1], "prod/us-east")).toBe(
      "/cluster/prod%2Fus-east/workloads/deployments?ns=payments&q=api",
    );
    expect(buildRunbookStepUrl(runbook.steps[2], "prod/us-east")).toBe(
      "/cluster/prod%2Fus-east/logs?ns=payments&kind=deployment&name=api&grep=panic",
    );
    expect(
      buildRunbookStepUrl(
        {
          id: "step-ai",
          kind: "ask-ai",
          title: "Ask AI",
          prompt: "Why is deployment/api restarting?",
        },
        "prod/us-east",
      ),
    ).toBe(
      "/cluster/prod%2Fus-east/ai?task=root-cause&question=Why+is+deployment%2Fapi+restarting%3F",
    );
  });
});
