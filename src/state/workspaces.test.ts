import { beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACES_STORAGE_KEY,
  buildWorkspaceRestoreUrl,
  validateWorkspaceInput,
  useWorkspacesStore,
  type WorkspaceInput,
} from "./workspaces";

const base: WorkspaceInput = {
  name: "Prod API triage",
  context: "prod/us-east",
  namespace: "payments",
  route: "/cluster/old/workloads/deployments?sort=age",
  search: "status:failed",
  selectedResource: {
    kind: "deployment",
    namespace: "payments",
    name: "api",
  },
  logQuery: {
    namespace: "payments",
    kind: "deployment",
    name: "api",
    filter: "timeout",
  },
  notes: "Check the rollout and recent errors.",
};

beforeEach(() => {
  window.localStorage.clear();
  useWorkspacesStore.getState().reset();
});

describe("workspaces store", () => {
  it("validates required fields and safe cluster routes", () => {
    expect(validateWorkspaceInput({ ...base, name: "" })).toContain(
      "Name is required.",
    );
    expect(validateWorkspaceInput({ ...base, context: "" })).toContain(
      "Cluster context is required.",
    );
    expect(
      validateWorkspaceInput({ ...base, route: "https://example.com" }),
    ).toContain("Route must stay inside Lumen.");
    expect(validateWorkspaceInput(base)).toEqual([]);
  });

  it("adds, updates, deletes, and persists saved workspaces", () => {
    const saved = useWorkspacesStore.getState().addWorkspace(base, 1_700);

    expect(saved.name).toBe("Prod API triage");
    expect(saved.createdAt).toBe(1_700);
    expect(useWorkspacesStore.getState().workspaces).toHaveLength(1);
    expect(
      JSON.parse(window.localStorage.getItem(WORKSPACES_STORAGE_KEY) ?? "[]"),
    ).toHaveLength(1);

    useWorkspacesStore
      .getState()
      .updateWorkspace(saved.id, { name: "Prod API errors" }, 1_900);
    expect(useWorkspacesStore.getState().workspaces[0]).toMatchObject({
      name: "Prod API errors",
      createdAt: 1_700,
      updatedAt: 1_900,
    });

    useWorkspacesStore.getState().deleteWorkspace(saved.id);
    expect(useWorkspacesStore.getState().workspaces).toEqual([]);
    expect(window.localStorage.getItem(WORKSPACES_STORAGE_KEY)).toBe("[]");
  });

  it("builds restore URLs with the saved context and supported filters", () => {
    expect(
      buildWorkspaceRestoreUrl({
        ...base,
        id: "ws-1",
        route: base.route ?? "workloads",
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toBe(
      "/cluster/prod%2Fus-east/workloads/deployments?sort=age&ns=payments&q=status%3Afailed",
    );
  });

  it("builds log restore URLs from structured log query context", () => {
    expect(
      buildWorkspaceRestoreUrl({
        ...base,
        id: "ws-1",
        route: "/cluster/old/logs",
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toBe(
      "/cluster/prod%2Fus-east/logs?ns=payments&kind=deployment&name=api&grep=timeout",
    );
  });
});
