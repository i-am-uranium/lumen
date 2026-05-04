import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Eye,
  Infinity as InfinityIcon,
  KeyRound,
  Pencil,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Timer,
  Undo2,
  Users,
  UserPlus,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  k8s,
  type AccessTemplate,
  type TeamAccessResult,
  type CreatedObject,
  type TeamGrant,
  type TokenMode,
} from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";

const TEMPLATES: {
  value: AccessTemplate;
  label: string;
  icon: React.ReactNode;
  tone: string;
  summary: string;
  rules: string;
}[] = [
  {
    value: "viewer",
    label: "viewer",
    icon: <Eye className="size-4" />,
    tone: "text-blue-400 border-blue-500/40 bg-blue-500/10",
    summary: "read-only access",
    rules:
      "get / list / watch on pods, services, endpoints, configmaps, events, deployments, statefulsets, daemonsets, jobs, cronjobs, ingresses, HPAs",
  },
  {
    value: "editor",
    label: "editor",
    icon: <Pencil className="size-4" />,
    tone: "text-amber-400 border-amber-500/40 bg-amber-500/10",
    summary: "create / update / delete on workloads",
    rules:
      "viewer rules + create / update / patch / delete. Cannot touch RBAC, secrets (except configmaps), CRDs, or cluster-scoped resources.",
  },
  {
    value: "admin",
    label: "admin",
    icon: <Sparkles className="size-4" />,
    tone: "text-red-400 border-red-500/40 bg-red-500/10",
    summary: "full access inside the selected scope",
    rules: "* on *. Scope this to dedicated namespaces — never cluster-wide unless you really mean it.",
  },
];

type PendingTeamMutation =
  | { kind: "rotate"; grant: TeamGrant }
  | { kind: "revoke"; memberId: string; namespaces: string[] };

export function TeamAccess() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const qc = useQueryClient();

  const { data: allNamespaces = [] } = useQuery({
    queryKey: ["k8s", "namespaces", context],
    queryFn: () => k8s.listNamespaces(context || undefined),
    staleTime: 60_000,
  });

  const grants = useQuery({
    queryKey: ["k8s", "team-access", context],
    queryFn: () => k8s.listTeamAccess(context || undefined),
    staleTime: 15_000,
  });

  const [memberId, setMemberId] = useState("");
  const [template, setTemplate] = useState<AccessTemplate>("viewer");
  const [scope, setScope] = useState<"namespaces" | "cluster">("namespaces");
  const [chosenNs, setChosenNs] = useState<Set<string>>(new Set());
  const [ttl, setTtl] = useState(8);
  const [longLived, setLongLived] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TeamAccessResult | null>(null);
  const [renewTarget, setRenewTarget] = useState<TeamGrant | null>(null);
  const [pendingMutation, setPendingMutation] = useState<PendingTeamMutation | null>(null);

  const handleRenew = async (g: TeamGrant, ttlHours: number) => {
    try {
      const res = await k8s.renewTeamToken(g.member_id, ttlHours, context || undefined);
      setResult(res);
      setRenewTarget(null);
      toast.success(`new token issued for ${g.member_id}`);
    } catch (e) {
      toast.error(`renew failed: ${(e as Error).message ?? e}`);
    }
  };

  // Long-lived rotate: deletes the existing token Secret and recreates it,
  // forcing the kubelet token-controller to issue a fresh JWT. The previous
  // token becomes invalid the moment the Secret is deleted, so this is a
  // one-click revoke+reissue rather than a "re-download same token" flow.
  const executeRotate = async (g: TeamGrant) => {
    try {
      const res = await k8s.rotateTeamToken(g.member_id, context || undefined);
      setResult(res);
      setRenewTarget(null);
      setPendingMutation(null);
      toast.success(`rotated long-lived token for ${g.member_id}`);
    } catch (e) {
      toast.error(`rotate failed: ${(e as Error).message ?? e}`);
    }
  };

  const canSubmit =
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(memberId) &&
    memberId.length <= 40 &&
    (scope === "cluster" || chosenNs.size > 0);

  const toggleNs = (n: string) => {
    const next = new Set(chosenNs);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    setChosenNs(next);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    try {
      const res = await k8s.provisionTeamAccess(
        {
          member_id: memberId,
          namespaces: scope === "cluster" ? [] : Array.from(chosenNs),
          template,
          ttl_hours: ttl,
          long_lived: longLived,
          service_account_namespace: null,
        },
        context || undefined,
      );
      setResult(res);
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ["k8s", "team-access", context] });
      toast.success(`access provisioned for ${memberId}`);
    } catch (e) {
      toast.error(`provisioning failed: ${(e as Error).message ?? e}`);
    } finally {
      setLoading(false);
    }
  };

  const executeRevoke = async (memberId: string, namespaces: string[]) => {
    try {
      await k8s.revokeTeamAccess(memberId, namespaces, context || undefined);
      toast.success(`revoked ${memberId}`);
      setResult(null);
      setPendingMutation(null);
      qc.invalidateQueries({ queryKey: ["k8s", "team-access", context] });
    } catch (e) {
      toast.error(`revoke failed: ${(e as Error).message ?? e}`);
    }
  };

  const chosenList = scope === "cluster" ? ["(cluster-wide)"] : Array.from(chosenNs);
  const mutationDialog = pendingMutation ? (
    <ConfirmActionDialog
      open
      title={
        pendingMutation.kind === "rotate"
          ? `rotate ${pendingMutation.grant.member_id}`
          : `revoke ${pendingMutation.memberId}`
      }
      description={
        pendingMutation.kind === "rotate"
          ? "This deletes and recreates the long-lived token Secret. The current token is invalidated immediately."
          : "This deletes Lumen-managed RBAC objects and token material for this team member."
      }
      target={
        pendingMutation.kind === "rotate"
          ? pendingMutation.grant.member_id
          : pendingMutation.memberId
      }
      confirmLabel={pendingMutation.kind === "rotate" ? "rotate" : "revoke"}
      intent="danger"
      onCancel={() => setPendingMutation(null)}
      onConfirm={() => {
        if (pendingMutation.kind === "rotate") {
          void executeRotate(pendingMutation.grant);
        } else {
          void executeRevoke(pendingMutation.memberId, pendingMutation.namespaces);
        }
      }}
    />
  ) : null;

  if (result) {
    return (
      <>
        <ResultView
          result={result}
          memberId={memberId}
          onReset={() => {
            setResult(null);
            setMemberId("");
            setChosenNs(new Set());
          }}
          onRevoke={() =>
            setPendingMutation({
              kind: "revoke",
              memberId,
              namespaces:
                scope === "cluster"
                  ? [result.sa_namespace]
                  : Array.from(chosenNs),
            })
          }
        />
        {mutationDialog}
      </>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="px-6 py-4 border-b border-term-border-soft sticky top-0 bg-term-bg/95 backdrop-blur">
        <h1 className="mds-heading text-[20px] text-term-fg flex items-center gap-2">
          <UserPlus className="size-5" /> team access
        </h1>
        <p className="text-[12px] text-term-muted">
          {context} · mint scoped, short-lived credentials for a team member.
        </p>
      </div>

      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <ExistingGrants
          grants={grants.data ?? []}
          loading={grants.isLoading}
          fetching={grants.isFetching}
          error={grants.error as Error | null}
          onRefresh={() => grants.refetch()}
          onRevoke={(g) =>
            setPendingMutation({
              kind: "revoke",
              memberId: g.member_id,
              namespaces: g.namespaces,
            })
          }
          onRenew={(g) => setRenewTarget(g)}
          onRotate={(g) => setPendingMutation({ kind: "rotate", grant: g })}
        />

        {renewTarget && (
          <RenewDialog
            grant={renewTarget}
            onCancel={() => setRenewTarget(null)}
            onRenew={(ttlHours) => handleRenew(renewTarget, ttlHours)}
          />
        )}

        {/* Member */}
        <Section title="1. identify the team member" subtitle="a handle Lumen will use for all created objects">
          <label className="block text-[11px] text-term-subtle uppercase tracking-wider mb-1.5">
            member id
          </label>
          <input
            value={memberId}
            onChange={(e) => setMemberId(e.target.value.toLowerCase())}
            placeholder="alice"
            className="term-input w-full max-w-xs"
            maxLength={40}
            autoFocus
          />
          <p className="text-[11px] text-term-subtle mt-1">
            lowercase letters, digits, and dashes · used to name the SA
            (<span className="text-term-muted font-mono">
              lumen-team-{memberId || "…"}
            </span>) and bindings
          </p>
        </Section>

        {/* Template */}
        <Section title="2. pick a permission template" subtitle="start restrictive; widen only if needed">
          <div className="grid gap-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.value}
                onClick={() => setTemplate(t.value)}
                className={cn(
                  "text-left p-3 rounded-lg border transition-colors flex items-start gap-3",
                  template === t.value
                    ? t.tone
                    : "border-term-border-soft hover:bg-term-panel-2 text-term-fg",
                )}
              >
                <span className="shrink-0 mt-0.5">{t.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[13px]">{t.label}</span>
                    <span className="text-[11px] text-term-subtle">{t.summary}</span>
                  </div>
                  <div className="text-[11px] text-term-muted mt-0.5">{t.rules}</div>
                </div>
                {template === t.value && <Check className="size-4 shrink-0 mt-0.5" />}
              </button>
            ))}
          </div>
        </Section>

        {/* Scope */}
        <Section title="3. scope it" subtitle="namespaced bindings are safer than cluster-wide">
          <div className="flex items-center gap-3 mb-3">
            {(["namespaces", "cluster"] as const).map((s) => (
              <label
                key={s}
                className={cn(
                  "inline-flex items-center gap-2 px-3 h-8 rounded-md border cursor-pointer text-[12px]",
                  scope === s
                    ? "border-term-green/60 text-term-green bg-term-green-soft"
                    : "border-term-border-soft text-term-muted hover:bg-term-panel-2",
                )}
              >
                <input
                  type="radio"
                  name="scope"
                  checked={scope === s}
                  onChange={() => setScope(s)}
                  className="hidden"
                />
                {s === "namespaces" ? "specific namespaces" : "cluster-wide"}
              </label>
            ))}
          </div>
          {scope === "namespaces" ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 max-h-[220px] overflow-y-auto p-2 rounded-md bg-term-bg border border-term-border-soft">
              {allNamespaces.map((n) => (
                <button
                  key={n}
                  onClick={() => toggleNs(n)}
                  className={cn(
                    "text-left px-2 py-1 rounded text-[12px] font-mono border transition-colors",
                    chosenNs.has(n)
                      ? "bg-term-green-soft text-term-green border-term-green/40"
                      : "border-transparent text-term-fg hover:bg-term-panel-2",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex items-start gap-2 p-3 rounded-md bg-term-red/10 border border-term-red/30 text-[12px] text-term-red">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              cluster-wide access creates a ClusterRole + ClusterRoleBinding.
              Prefer per-namespace scope unless the user genuinely needs to
              read/write everywhere.
            </div>
          )}
        </Section>

        {/* Token lifetime */}
        <Section
          title="4. token lifetime"
          subtitle="short-lived rotates via Lumen; long-lived stays valid until revoked"
        >
          <div className="grid gap-2 mb-3">
            <button
              type="button"
              onClick={() => setLongLived(false)}
              className={cn(
                "text-left p-3 rounded-lg border flex items-start gap-3 transition-colors",
                !longLived
                  ? "border-term-green/60 bg-term-green-soft text-term-green"
                  : "border-term-border-soft hover:bg-term-panel-2 text-term-fg",
              )}
            >
              <Timer className="size-4 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[13px]">short-lived (default)</span>
                  <span className="text-[11px] text-term-subtle">
                    TokenRequest · max 24h
                  </span>
                </div>
                <div className="text-[11px] text-term-muted mt-0.5">
                  Safer if leaked. You have to renew in Lumen when it expires — the
                  team member can't self-rotate.
                </div>
              </div>
              {!longLived && <Check className="size-4 shrink-0 mt-0.5" />}
            </button>
            <button
              type="button"
              onClick={() => setLongLived(true)}
              className={cn(
                "text-left p-3 rounded-lg border flex items-start gap-3 transition-colors",
                longLived
                  ? "border-amber-500/60 bg-amber-500/10 text-amber-300"
                  : "border-term-border-soft hover:bg-term-panel-2 text-term-fg",
              )}
            >
              <InfinityIcon className="size-4 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[13px]">long-lived</span>
                  <span className="text-[11px] text-term-subtle">
                    Secret-backed · never expires
                  </span>
                </div>
                <div className="text-[11px] text-term-muted mt-0.5">
                  Same token forever until you revoke. No re-issue burden, but if it leaks it's
                  valid until someone clicks "revoke". Typical for long-running access.
                </div>
              </div>
              {longLived && <Check className="size-4 shrink-0 mt-0.5" />}
            </button>
          </div>
          {!longLived ? (
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={24}
                step={1}
                value={ttl}
                onChange={(e) => setTtl(parseInt(e.target.value))}
                className="flex-1 max-w-md"
              />
              <span className="text-[14px] text-term-fg font-mono tabular-nums w-16">
                {ttl} hour{ttl === 1 ? "" : "s"}
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 text-[12px] text-amber-300">
              <AlertTriangle className="size-4 shrink-0 mt-0.5" />
              Creates a Secret of type <span className="font-mono">kubernetes.io/service-account-token</span>{" "}
              bound to the SA. The token never rotates; revoke the grant to invalidate it.
            </div>
          )}
        </Section>

        <div className="sticky bottom-0 -mx-6 px-6 py-4 bg-term-bg/95 backdrop-blur border-t border-term-border-soft flex items-center justify-between">
          <SummaryLine
            template={template}
            chosen={chosenList}
            ttl={ttl}
            longLived={longLived}
          />
          <div className="flex gap-2">
            <button
              onClick={() => setConfirming(true)}
              disabled={!canSubmit || loading}
              className="term-btn term-btn-primary !min-h-[34px] !text-[12px]"
            >
              <KeyRound className="size-3.5" /> review & provision
            </button>
          </div>
        </div>

        {confirming && (
          <ConfirmDialog
            onClose={() => setConfirming(false)}
            onConfirm={submit}
            memberId={memberId}
            template={template}
            scope={scope}
            namespaces={Array.from(chosenNs)}
            ttl={ttl}
            longLived={longLived}
            loading={loading}
          />
        )}
        {mutationDialog}
      </div>
    </div>
  );
}

function ExistingGrants({
  grants,
  loading,
  fetching,
  error,
  onRefresh,
  onRevoke,
  onRenew,
  onRotate,
}: {
  grants: TeamGrant[];
  loading: boolean;
  fetching: boolean;
  error: Error | null;
  onRefresh: () => void;
  onRevoke: (g: TeamGrant) => void;
  onRenew: (g: TeamGrant) => void;
  onRotate: (g: TeamGrant) => void;
}) {
  return (
    <section className="rounded-lg border border-term-border-soft bg-term-panel">
      <header className="flex items-center justify-between px-4 py-3 border-b border-term-border-soft">
        <div className="flex items-center gap-2">
          <Users className="size-4 text-term-muted" />
          <h2 className="text-[14px] font-semibold text-term-fg">existing access</h2>
          <span className="text-[11px] text-term-subtle">
            {loading ? "scanning…" : `${grants.length} team member${grants.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <button
          onClick={onRefresh}
          disabled={fetching}
          className="text-term-subtle hover:text-term-fg"
          title="rescan cluster for Lumen-managed RBAC"
        >
          <RefreshCw className={cn("size-3.5", fetching && "animate-spin")} />
        </button>
      </header>

      {error ? (
        <div className="p-4 text-[12px] text-term-red">{error.message}</div>
      ) : loading ? (
        <div className="p-4 text-[12px] text-term-muted">looking up Lumen-managed RBAC…</div>
      ) : grants.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-term-muted">
          no existing grants in this cluster. Use the wizard below to create one.
        </div>
      ) : (
        <ul className="divide-y divide-term-border-soft">
          {grants.map((g) => (
            <li key={g.member_id} className="px-4 py-3 flex items-start gap-3">
              <div className="flex flex-col flex-1 min-w-0 gap-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold text-term-fg font-mono">
                    {g.member_id}
                  </span>
                  {g.template && <TemplateBadge template={g.template} />}
                  {g.token_mode && <TokenModeBadge mode={g.token_mode} />}
                  {g.cluster_wide ? (
                    <span className="px-1.5 py-0.5 text-[10px] rounded bg-red-500/10 border border-red-500/40 text-red-300 font-semibold uppercase tracking-wide">
                      cluster-wide
                    </span>
                  ) : (
                    <span className="text-[11px] text-term-subtle">
                      ns: {g.namespaces.length ? g.namespaces.join(", ") : "—"}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-term-muted font-mono">
                  {g.service_account && (
                    <span>
                      sa:{" "}
                      <span className="text-term-fg">
                        {g.sa_namespace ? `${g.sa_namespace}/` : ""}
                        {g.service_account}
                      </span>
                    </span>
                  )}
                  <span>· {g.object_count} objects</span>
                  <span>· age {formatAge(g.sa_age_seconds)}</span>
                </div>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button
                  onClick={() => onRenew(g)}
                  className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px]"
                  title={
                    g.token_mode === "long"
                      ? "re-download the existing long-lived kubeconfig (token does not change)"
                      : "issue a fresh short-lived kubeconfig — no RBAC changes"
                  }
                >
                  <RotateCw className="size-3" />{" "}
                  {g.token_mode === "long" ? "re-download" : "renew"}
                </button>
                {g.token_mode === "long" && (
                  <button
                    onClick={() => onRotate(g)}
                    className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px] !text-term-amber !border-term-amber/40"
                    title="invalidate the current long-lived token and issue a new one"
                  >
                    <RotateCw className="size-3" /> rotate
                  </button>
                )}
                <button
                  onClick={() => onRevoke(g)}
                  className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px] !text-term-red !border-term-red/40"
                  title="delete Lumen-managed RBAC for this member"
                >
                  <Undo2 className="size-3" /> revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RenewDialog({
  grant,
  onCancel,
  onRenew,
}: {
  grant: TeamGrant;
  onCancel: () => void;
  onRenew: (ttlHours: number) => void | Promise<void>;
}) {
  const [ttl, setTtl] = useState(8);
  const [busy, setBusy] = useState(false);
  const isLong = grant.token_mode === "long";
  const go = async () => {
    setBusy(true);
    try {
      await onRenew(isLong ? 0 : ttl);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-term-panel border border-term-border rounded-lg max-w-md w-full shadow-2xl"
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-term-border-soft">
          <h3 className="text-[13px] font-semibold text-term-fg flex items-center gap-2">
            <RotateCw className="size-3.5" />
            {isLong ? "re-download kubeconfig" : "renew token"} · {grant.member_id}
          </h3>
          <button onClick={onCancel} className="text-term-subtle hover:text-term-fg">
            <X className="size-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 text-[12px]">
          {isLong ? (
            <>
              <p className="text-term-muted">
                This grant uses a <span className="text-amber-300">long-lived</span> Secret
                token — it doesn't rotate. Re-download re-emits the same token inside a
                fresh kubeconfig so you can hand it over again.
              </p>
              <div className="flex items-start gap-2 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-300">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                To invalidate the current token, revoke the grant and re-provision.
              </div>
            </>
          ) : (
            <>
              <p className="text-term-muted">
                Mint a new short-lived token against the existing
                <span className="text-term-fg font-mono"> {grant.service_account}</span>.
                Roles and bindings are not touched. Hand the new kubeconfig to the team
                member over a secure channel before the previous token expires.
              </p>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-term-subtle mb-1.5">
                  new token lifetime
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={24}
                    step={1}
                    value={ttl}
                    onChange={(e) => setTtl(parseInt(e.target.value))}
                    className="flex-1"
                  />
                  <span className="text-[14px] text-term-fg font-mono tabular-nums w-16 text-right">
                    {ttl} hour{ttl === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="px-4 py-3 border-t border-term-border-soft flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="term-btn !min-h-[30px] !text-[11px]"
          >
            cancel
          </button>
          <button
            onClick={go}
            disabled={busy}
            className="term-btn term-btn-primary !min-h-[30px] !text-[11px]"
          >
            <KeyRound className="size-3.5" /> issue kubeconfig
          </button>
        </div>
      </div>
    </div>
  );
}

function TokenModeBadge({ mode }: { mode: TokenMode }) {
  if (mode === "short") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border font-semibold uppercase tracking-wide bg-emerald-500/10 text-emerald-300 border-emerald-500/40">
        <Timer className="size-2.5" /> short-lived
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border font-semibold uppercase tracking-wide bg-amber-500/10 text-amber-300 border-amber-500/40">
      <InfinityIcon className="size-2.5" /> long-lived
    </span>
  );
}

function TemplateBadge({ template }: { template: AccessTemplate }) {
  const cls =
    template === "viewer"
      ? "bg-blue-500/10 text-blue-300 border-blue-500/40"
      : template === "editor"
        ? "bg-amber-500/10 text-amber-300 border-amber-500/40"
        : "bg-red-500/10 text-red-300 border-red-500/40";
  return (
    <span
      className={cn(
        "px-1.5 py-0.5 text-[10px] rounded border font-semibold uppercase tracking-wide",
        cls,
      )}
    >
      {template}
    </span>
  );
}

function formatAge(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-term-border-soft bg-term-panel p-4">
      <header className="mb-3">
        <h2 className="text-[14px] font-semibold text-term-fg">{title}</h2>
        {subtitle && (
          <p className="text-[11px] text-term-muted mt-0.5">{subtitle}</p>
        )}
      </header>
      {children}
    </section>
  );
}

function SummaryLine({
  template,
  chosen,
  ttl,
  longLived,
}: {
  template: AccessTemplate;
  chosen: string[];
  ttl: number;
  longLived: boolean;
}) {
  return (
    <div className="text-[12px] text-term-muted">
      <span className="text-term-fg font-mono">{template}</span>
      <span className="text-term-subtle"> · </span>
      {chosen.length > 0 ? (
        <span className="font-mono">{chosen.slice(0, 3).join(", ")}</span>
      ) : (
        <span className="text-term-subtle italic">pick scope</span>
      )}
      {chosen.length > 3 && (
        <span className="text-term-subtle"> +{chosen.length - 3}</span>
      )}
      <span className="text-term-subtle"> · </span>
      <span
        className={cn(
          "font-mono tabular-nums",
          longLived && "text-amber-300",
        )}
      >
        {longLived ? "long-lived" : `${ttl}h`}
      </span>
    </div>
  );
}

function ConfirmDialog({
  onClose,
  onConfirm,
  memberId,
  template,
  scope,
  namespaces,
  ttl,
  longLived,
  loading,
}: {
  onClose: () => void;
  onConfirm: () => void;
  memberId: string;
  template: AccessTemplate;
  scope: "namespaces" | "cluster";
  namespaces: string[];
  ttl: number;
  longLived: boolean;
  loading: boolean;
}) {
  const [typed, setTyped] = useState("");
  const confirmed = typed === memberId;
  const toCreate = useMemo(() => {
    const base = [`ServiceAccount/lumen-team-${memberId}`];
    const rbac =
      scope === "cluster"
        ? [
            `ClusterRole/lumen-team-${memberId}`,
            `ClusterRoleBinding/lumen-team-${memberId}-cluster`,
          ]
        : namespaces.flatMap((n) => [
            `Role/lumen-team-${memberId} in ${n}`,
            `RoleBinding/lumen-team-${memberId}-${n} in ${n}`,
          ]);
    const tokenObjs = longLived
      ? [`Secret/lumen-team-${memberId}-token (kubernetes.io/service-account-token)`]
      : [];
    return [...base, ...rbac, ...tokenObjs];
  }, [memberId, scope, namespaces, longLived]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-term-panel border border-term-border rounded-lg max-w-lg w-full shadow-2xl"
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-term-border-soft">
          <h3 className="text-[13px] font-semibold text-term-fg">
            confirm provisioning
          </h3>
          <button onClick={onClose} className="text-term-subtle hover:text-term-fg">
            <X className="size-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 text-[12px]">
          <p className="text-term-muted">
            Lumen will apply the following objects to the cluster. Existing
            objects with the same name will be overwritten via server-side
            apply.
          </p>
          <ul className="space-y-1 text-term-fg font-mono">
            {toCreate.map((t) => (
              <li key={t} className="flex items-center gap-2">
                <Check className="size-3 text-term-green" /> {t}
              </li>
            ))}
          </ul>
          <div className="pt-2 border-t border-term-border-soft text-term-muted">
            {longLived ? (
              <>
                A <span className="text-amber-300 font-semibold">long-lived</span>{" "}
                token will be issued via a Secret. It will not expire until you
                revoke the grant.
              </>
            ) : (
              <>A short-lived token ({ttl}h) will be issued via TokenRequest.</>
            )}{" "}
            Template: <span className="text-term-fg font-mono">{template}</span>.
          </div>
          <label className="block">
            <span className="text-[11px] text-term-muted">
              Type <span className="font-mono text-term-fg">{memberId}</span> to confirm provisioning.
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="term-input mt-2 w-full font-mono"
              aria-label="confirmation text"
              autoFocus
            />
          </label>
        </div>
        <div className="px-4 py-3 border-t border-term-border-soft flex justify-end gap-2">
          <button
            onClick={onClose}
            className="term-btn !min-h-[30px] !text-[11px]"
            disabled={loading}
          >
            cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || !confirmed}
            className="term-btn term-btn-primary !min-h-[30px] !text-[11px]"
          >
            <ShieldCheck className="size-3.5" /> apply
          </button>
        </div>
      </div>
    </div>
  );
}

function ResultView({
  result,
  memberId,
  onReset,
  onRevoke,
}: {
  result: TeamAccessResult;
  memberId: string;
  onReset: () => void;
  onRevoke: () => void;
}) {
  const copy = async () => {
    await navigator.clipboard.writeText(result.kubeconfig_yaml);
    toast.success("kubeconfig copied");
  };
  const download = () => {
    const blob = new Blob([result.kubeconfig_yaml], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lumen-team-${memberId}.kubeconfig.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full overflow-auto">
      <div className="px-6 py-4 border-b border-term-border-soft sticky top-0 bg-term-bg/95 backdrop-blur flex items-start justify-between">
        <div>
          <h1 className="mds-heading text-[20px] text-term-fg flex items-center gap-2">
            <ShieldCheck className="size-5 text-term-green" /> access provisioned
          </h1>
          <p className="text-[12px] text-term-muted">
            {result.service_account} in {result.sa_namespace} · token expires{" "}
            {new Date(result.token_expires_at).toLocaleString()}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onRevoke}
            className="term-btn !min-h-[32px] !text-[12px] !text-term-red !border-term-red/40"
          >
            <Undo2 className="size-3.5" /> revoke
          </button>
          <button
            onClick={onReset}
            className="term-btn !min-h-[32px] !text-[12px]"
          >
            another
          </button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-6 space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 text-[12px] text-amber-300">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div>
            <strong>Treat this kubeconfig as a secret.</strong> Hand it to the
            team member over a secure channel (1Password, encrypted Slack DM —
            not plain chat). When it expires, run this wizard again.
          </div>
        </div>

        <div className="rounded-lg border border-term-border-soft overflow-hidden">
          <div className="flex items-center justify-between px-3 h-9 bg-term-panel border-b border-term-border-soft">
            <span className="text-[11px] text-term-muted uppercase tracking-wider">
              kubeconfig.yaml
            </span>
            <div className="flex gap-1">
              <button
                onClick={copy}
                className="term-btn !min-h-[26px] !py-1 !px-2 !text-[11px]"
              >
                <Copy className="size-3" /> copy
              </button>
              <button
                onClick={download}
                className="term-btn !min-h-[26px] !py-1 !px-2 !text-[11px]"
              >
                <Download className="size-3" /> download
              </button>
            </div>
          </div>
          <pre className="p-3 text-[11px] font-mono text-term-fg overflow-auto max-h-[360px]">
            {result.kubeconfig_yaml}
          </pre>
        </div>

        <div>
          <h3 className="text-[12px] uppercase tracking-wider text-term-subtle mb-2">
            objects created ({result.created.length})
          </h3>
          <ul className="space-y-1 text-[12px] font-mono">
            {result.created.map((o: CreatedObject, i) => (
              <li
                key={i}
                className="flex items-center gap-2 p-2 rounded bg-term-panel border border-term-border-soft"
              >
                <Check className="size-3 text-term-green shrink-0" />
                <span className="text-term-muted w-[160px]">{o.kind}</span>
                <span className="text-term-fg truncate">{o.name}</span>
                {o.namespace && (
                  <span className="text-term-subtle">in {o.namespace}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
