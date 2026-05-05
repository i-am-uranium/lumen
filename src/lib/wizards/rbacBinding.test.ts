import { describe, expect, it } from "vitest";
import {
  buildRbacBindingManifest,
  validate,
  type WizardSpec,
} from "./rbacBinding";

const baseSpec: WizardSpec = {
  name: "team-platform-readonly",
  bindingScope: "namespace",
  namespace: "default",
  roleKind: "ClusterRole",
  roleName: "view",
  subjects: [{ kind: "User", name: "alice@example.com" }],
};

describe("buildRbacBindingManifest", () => {
  it("emits a RoleBinding for namespace-scoped bindings", () => {
    const m = buildRbacBindingManifest(baseSpec);
    expect(m).toMatchObject({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: "team-platform-readonly", namespace: "default" },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "view",
      },
      subjects: [
        {
          kind: "User",
          name: "alice@example.com",
          apiGroup: "rbac.authorization.k8s.io",
        },
      ],
    });
  });

  it("emits a ClusterRoleBinding for cluster-scoped bindings", () => {
    const m = buildRbacBindingManifest({
      ...baseSpec,
      bindingScope: "cluster",
    });
    expect(m).toMatchObject({
      kind: "ClusterRoleBinding",
      metadata: { name: "team-platform-readonly" },
    });
    expect((m.metadata as Record<string, unknown>).namespace).toBeUndefined();
  });

  it("preserves namespace on ServiceAccount subjects", () => {
    const m = buildRbacBindingManifest({
      ...baseSpec,
      subjects: [
        { kind: "ServiceAccount", name: "deployer", namespace: "ci" },
      ],
    });
    expect((m.subjects as Array<Record<string, unknown>>)[0]).toEqual({
      kind: "ServiceAccount",
      name: "deployer",
      namespace: "ci",
    });
  });

  it("drops empty-name subjects from the output", () => {
    const m = buildRbacBindingManifest({
      ...baseSpec,
      subjects: [
        { kind: "User", name: "alice@example.com" },
        { kind: "User", name: "" },
      ],
    });
    expect((m.subjects as unknown[]).length).toBe(1);
  });
});

describe("validate", () => {
  it("flags missing name + namespace + role", () => {
    expect(
      validate({
        name: "",
        bindingScope: "namespace",
        namespace: "",
        roleKind: "Role",
        roleName: "",
        subjects: [],
      }),
    ).toEqual(
      expect.arrayContaining([
        "name is required",
        "namespace is required for a RoleBinding",
        "role name is required",
        "at least one subject is required",
      ]),
    );
  });

  it("rejects ClusterRoleBinding referencing a Role", () => {
    expect(
      validate({
        ...baseSpec,
        bindingScope: "cluster",
        roleKind: "Role",
      }),
    ).toContain("ClusterRoleBinding cannot reference a namespaced Role");
  });

  it("requires namespace on ServiceAccount subjects", () => {
    expect(
      validate({
        ...baseSpec,
        subjects: [{ kind: "ServiceAccount", name: "deployer" }],
      }),
    ).toContain("ServiceAccount deployer needs a namespace");
  });

  it("returns empty array on a valid spec", () => {
    expect(validate(baseSpec)).toEqual([]);
  });
});
