import { beforeEach, describe, expect, it, vi } from "vitest";
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
  it("restores legacy assistant steps as manual checks without losing prompts or notes", async () => {
    const stored = [{ id: "saved", name: "Incident", createdAt: 1, updatedAt: 2,
      steps: [{ id: "legacy", kind: "ask-ai", title: "Investigate API", prompt: "Why is API restarting?", note: "Contact owner first." }],
    }];
    window.localStorage.setItem(RUNBOOKS_STORAGE_KEY, JSON.stringify(stored));
    vi.resetModules();
    const { useRunbooksStore: restoredStore } = await import("./runbooks");
    const saved = restoredStore.getState().runbooks[0];
    expect(saved).toMatchObject({ id: "saved", createdAt: 1, updatedAt: 2 });
    expect(saved.steps[0]).toMatchObject({ kind: "checklist", title: "Investigate API", note: "Contact owner first.\n\nWhy is API restarting?" });
    expect(buildRunbookStepUrl(saved.steps[0], "prod")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(RUNBOOKS_STORAGE_KEY)!)).toEqual(stored);
    restoredStore.getState().updateRunbook("saved", { description: "Reviewed" });
    const persisted = JSON.parse(window.localStorage.getItem(RUNBOOKS_STORAGE_KEY)!);
    expect(persisted[0].steps[0].note).toBe("Contact owner first.\n\nWhy is API restarting?");
  });

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

  it("builds safe step URLs for route, resource, and logs", () => {
    expect(buildRunbookStepUrl(runbook.steps[0], "prod/us-east")).toBe(
      "/cluster/prod%2Fus-east/workloads/deployments?ns=payments&q=api",
    );
    expect(buildRunbookStepUrl(runbook.steps[1], "prod/us-east")).toBe(
      "/cluster/prod%2Fus-east/workloads/deployments?ns=payments&q=api",
    );
    expect(buildRunbookStepUrl(runbook.steps[2], "prod/us-east")).toBe(
      "/cluster/prod%2Fus-east/logs?ns=payments&kind=deployment&name=api&grep=panic",
    );
  });
});
