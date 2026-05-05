/**
 * Pure helpers for the RBAC binding wizard (D13).
 *
 * Builds either a RoleBinding (namespaced) or ClusterRoleBinding
 * (cluster-scoped). The roleRef can target either a Role or
 * ClusterRole — the matrix is:
 *
 *   bindingScope=namespace + role-kind=Role         → RoleBinding
 *   bindingScope=namespace + role-kind=ClusterRole  → RoleBinding (allowed)
 *   bindingScope=cluster   + role-kind=ClusterRole  → ClusterRoleBinding
 *   bindingScope=cluster   + role-kind=Role         → INVALID, surfaced
 *
 * Subjects can be a User, Group, or ServiceAccount. Each row corresponds
 * to one subject; the wizard supports multiple in a single binding.
 */

export type BindingScope = "namespace" | "cluster";
export type RoleKind = "Role" | "ClusterRole";
export type SubjectKind = "User" | "Group" | "ServiceAccount";

export type WizardSubject = {
  kind: SubjectKind;
  name: string;
  /** Required when kind=ServiceAccount. */
  namespace?: string;
};

export type WizardSpec = {
  name: string;
  bindingScope: BindingScope;
  /** Required when bindingScope=namespace. */
  namespace: string;
  roleKind: RoleKind;
  roleName: string;
  subjects: WizardSubject[];
};

export type ManifestObject = Record<string, unknown>;

export function buildRbacBindingManifest(spec: WizardSpec): ManifestObject {
  const apiVersion = "rbac.authorization.k8s.io/v1";
  const kind =
    spec.bindingScope === "cluster" ? "ClusterRoleBinding" : "RoleBinding";

  const metadata: Record<string, unknown> = {
    name: spec.name.trim(),
  };
  if (spec.bindingScope === "namespace") {
    metadata.namespace = spec.namespace.trim();
  }

  return {
    apiVersion,
    kind,
    metadata,
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: spec.roleKind,
      name: spec.roleName.trim(),
    },
    subjects: spec.subjects
      .filter((s) => s.name.trim().length > 0)
      .map((s) => {
        const out: Record<string, unknown> = {
          kind: s.kind,
          name: s.name.trim(),
        };
        // ServiceAccount subjects always have a namespace; User/Group don't
        // (they're cluster-scoped identities).
        if (s.kind === "ServiceAccount" && s.namespace?.trim()) {
          out.namespace = s.namespace.trim();
        }
        // The apiGroup field is conventionally added for User/Group.
        if (s.kind === "User" || s.kind === "Group") {
          out.apiGroup = "rbac.authorization.k8s.io";
        }
        return out;
      }),
  };
}

export function validate(spec: WizardSpec): string[] {
  const errs: string[] = [];
  if (!spec.name.trim()) errs.push("name is required");
  if (spec.bindingScope === "namespace" && !spec.namespace.trim()) {
    errs.push("namespace is required for a RoleBinding");
  }
  if (spec.bindingScope === "cluster" && spec.roleKind === "Role") {
    errs.push("ClusterRoleBinding cannot reference a namespaced Role");
  }
  if (!spec.roleName.trim()) errs.push("role name is required");
  const validSubjects = spec.subjects.filter((s) => s.name.trim().length > 0);
  if (validSubjects.length === 0) errs.push("at least one subject is required");
  for (const s of validSubjects) {
    if (s.kind === "ServiceAccount" && !s.namespace?.trim()) {
      errs.push(`ServiceAccount ${s.name} needs a namespace`);
    }
  }
  return errs;
}
