import { useMutationCapability } from "@/hooks/useMutationCapability";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { k8s, type WorkloadKind } from "@/lib/k8s";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LumenPage, PageHeader, SectionPanel } from "@/components/lumen/page";
import { manifestToYaml } from "@/lib/wizards/networkPolicy";
import {
  buildRbacBindingManifest,
  validate,
  type SubjectKind,
  type WizardSpec,
  type WizardSubject,
} from "@/lib/wizards/rbacBinding";

/**
 * D13 — RBAC binding wizard.
 *
 * Builds a RoleBinding (namespaced) or ClusterRoleBinding (cluster-
 * scoped) and applies via `apply_resource`. Pure read of namespace list
 * for the dropdown — no role enumeration in v1 (Lumen's TeamAccess view
 * is the place for that).
 *
 * Note: shares `manifestToYaml` with the NetworkPolicy wizard since the
 * helper is general-purpose. Splitting it into a generic util is the
 * right move once a third wizard appears.
 */
export function RbacBindingWizard() {
  const { ctx = "" } = useParams();
  const navigate = useNavigate();
  const context = decodeURIComponent(ctx);
  const capability = useMutationCapability(context);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data: namespaces = [] } = useQuery({
    queryKey: ["k8s", "namespaces", context],
    queryFn: () => k8s.listNamespaces(context || undefined),
    staleTime: 60_000,
  });

  const [spec, setSpec] = useState<WizardSpec>(() => ({
    name: "",
    bindingScope: "namespace",
    namespace: namespaces[0] ?? "default",
    roleKind: "ClusterRole",
    roleName: "view",
    subjects: [{ kind: "User", name: "" }],
  }));
  const [busy, setBusy] = useState(false);
  const [appliedDryRun, setAppliedDryRun] = useState(false);

  const errors = useMemo(() => validate(spec), [spec]);
  const yaml = useMemo(
    () => manifestToYaml(buildRbacBindingManifest(spec)),
    [spec],
  );

  async function apply(dryRun: boolean) {
    if (!dryRun && !capability.canMutate) { toast.error(capability.reason); return; }
    if (errors.length > 0) {
      toast.error(errors.join("; "));
      return;
    }
    setBusy(true);
    try {
      const kind: WorkloadKind =
        spec.bindingScope === "cluster" ? "clusterrolebinding" : "rolebinding";
      // ClusterRoleBinding is cluster-scoped, but apply_resource takes a
      // namespace string anyway; we pass an empty string and let the
      // backend's `prepare_apply_manifest` strip it for non-namespaced kinds.
      const ns =
        spec.bindingScope === "cluster" ? "" : spec.namespace.trim();
      await k8s.applyResource(
        ns,
        kind,
        spec.name.trim(),
        yaml,
        dryRun,
        context || undefined,
      );
      if (dryRun) {
        setAppliedDryRun(true);
        toast.success("dry-run accepted by API server");
      } else {
        toast.success(`${spec.name} applied`);
        navigate(`/cluster/${encodeURIComponent(context)}/access`);
      }
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <LumenPage>
      <ConfirmActionDialog open={confirmOpen} context={context} namespace={spec.namespace} title="Apply resource" description="Apply this manifest to the selected context." target={spec.name} confirmLabel="apply" busy={busy || !capability.canMutate} onCancel={() => setConfirmOpen(false)} onConfirm={() => { setConfirmOpen(false); void apply(false); }} />
      <PageHeader
        eyebrow="wizards"
        title="New RBAC binding"
        description="Bind a Role or ClusterRole to users, groups, or service accounts."
        icon={<ShieldCheck className="size-4" />}
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                navigate(`/cluster/${encodeURIComponent(context)}/access`)
              }
            >
              <ArrowLeft className="size-3.5" /> back
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void apply(true)}
              disabled={busy || errors.length > 0}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : appliedDryRun ? (
                <CheckCircle2 className="size-3.5" />
              ) : null}
              dry run
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={busy || errors.length > 0 || !capability.canMutate}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              apply
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <SectionPanel>
            <h2 className="mds-heading text-[14px] text-text-primary mb-3">
              Identity
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="binding name">
                <Input
                  value={spec.name}
                  onChange={(e) =>
                    setSpec((s) => ({ ...s, name: e.target.value }))
                  }
                  placeholder="team-platform-readonly"
                />
              </Field>
              <Field label="scope">
                <select
                  value={spec.bindingScope}
                  onChange={(e) =>
                    setSpec((s) => ({
                      ...s,
                      bindingScope: e.target.value as WizardSpec["bindingScope"],
                    }))
                  }
                  className="h-9 w-full rounded-control border border-border-default bg-elevated px-3 text-xs text-text-primary"
                >
                  <option value="namespace">namespace (RoleBinding)</option>
                  <option value="cluster">cluster (ClusterRoleBinding)</option>
                </select>
              </Field>
              {spec.bindingScope === "namespace" && (
                <Field label="namespace">
                  <select
                    value={spec.namespace}
                    onChange={(e) =>
                      setSpec((s) => ({ ...s, namespace: e.target.value }))
                    }
                    className="h-9 w-full rounded-control border border-border-default bg-elevated px-3 text-xs text-text-primary"
                  >
                    {namespaces.length === 0 && (
                      <option value="default">default</option>
                    )}
                    {namespaces.map((ns) => (
                      <option key={ns} value={ns}>
                        {ns}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          </SectionPanel>

          <SectionPanel>
            <h2 className="mds-heading text-[14px] text-text-primary mb-3">
              Role to bind
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="role kind">
                <select
                  value={spec.roleKind}
                  onChange={(e) =>
                    setSpec((s) => ({
                      ...s,
                      roleKind: e.target.value as WizardSpec["roleKind"],
                    }))
                  }
                  className="h-9 w-full rounded-control border border-border-default bg-elevated px-3 text-xs text-text-primary"
                >
                  <option value="ClusterRole">ClusterRole</option>
                  <option value="Role">Role</option>
                </select>
              </Field>
              <Field label="role name">
                <Input
                  value={spec.roleName}
                  onChange={(e) =>
                    setSpec((s) => ({ ...s, roleName: e.target.value }))
                  }
                  placeholder="view"
                />
              </Field>
            </div>
            <p className="mt-2 text-[11px] text-text-muted">
              Tip: built-in ClusterRoles include{" "}
              <code>view</code>, <code>edit</code>, <code>admin</code>,{" "}
              <code>cluster-admin</code>.
            </p>
          </SectionPanel>

          <SectionPanel>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="mds-heading text-[14px] text-text-primary">
                  Subjects
                </h2>
                <p className="text-[11px] text-text-muted">
                  Who gets these permissions?
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  setSpec((s) => ({
                    ...s,
                    subjects: [...s.subjects, { kind: "User", name: "" }],
                  }))
                }
                className="inline-flex items-center gap-1 text-[11px] text-accent-primary hover:underline"
              >
                <Plus className="size-3" /> add subject
              </button>
            </div>
            <div className="space-y-2">
              {spec.subjects.map((subject, i) => (
                <SubjectRow
                  key={i}
                  subject={subject}
                  namespaces={namespaces}
                  onChange={(next) =>
                    setSpec((s) => ({
                      ...s,
                      subjects: s.subjects.map((sub, j) =>
                        j === i ? next : sub,
                      ),
                    }))
                  }
                  onRemove={() =>
                    setSpec((s) => ({
                      ...s,
                      subjects: s.subjects.filter((_, j) => j !== i),
                    }))
                  }
                />
              ))}
            </div>
          </SectionPanel>

          {errors.length > 0 && (
            <div className="rounded-panel border border-warning/40 bg-warning-soft p-3 text-[11px] text-warning">
              <ul className="list-disc pl-4">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div>
          <SectionPanel className="sticky top-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="mds-heading text-[14px] text-text-primary">
                Manifest preview
              </h2>
              <span className="font-mono text-[10px] text-text-muted">
                rbac.authorization.k8s.io/v1
              </span>
            </div>
            <pre className="max-h-[60vh] overflow-auto rounded border border-border-subtle bg-code-surface p-3 font-mono text-[11px] leading-relaxed text-text-primary">
              {yaml}
            </pre>
          </SectionPanel>
        </div>
      </div>
    </LumenPage>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function SubjectRow({
  subject,
  namespaces,
  onChange,
  onRemove,
}: {
  subject: WizardSubject;
  namespaces: string[];
  onChange: (next: WizardSubject) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded border border-border-subtle bg-elevated p-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[160px_1fr_auto] sm:items-center">
        <select
          value={subject.kind}
          onChange={(e) =>
            onChange({ ...subject, kind: e.target.value as SubjectKind })
          }
          className="h-9 rounded-control border border-border-default bg-surface px-2 text-xs text-text-primary"
        >
          <option value="User">User</option>
          <option value="Group">Group</option>
          <option value="ServiceAccount">ServiceAccount</option>
        </select>
        <Input
          value={subject.name}
          onChange={(e) => onChange({ ...subject, name: e.target.value })}
          placeholder={
            subject.kind === "User"
              ? "alice@example.com"
              : subject.kind === "Group"
                ? "system:authenticated"
                : "default"
          }
        />
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 text-text-muted hover:bg-surface hover:text-danger"
          aria-label="remove subject"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {subject.kind === "ServiceAccount" && (
        <div className="mt-2">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-text-muted">
            service-account namespace
          </span>
          <select
            value={subject.namespace ?? ""}
            onChange={(e) =>
              onChange({ ...subject, namespace: e.target.value })
            }
            className="h-8 w-full rounded-control border border-border-default bg-surface px-2 text-xs text-text-primary"
          >
            <option value="">— select —</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
