import { useMutationCapability } from "@/hooks/useMutationCapability";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  Globe,
  Loader2,
  Network,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { k8s } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LumenPage, PageHeader, SectionPanel } from "@/components/lumen/page";
import {
  buildNetworkPolicyManifest,
  finalizeManifest,
  manifestToYaml,
  validate,
  type Label,
  type WizardPeer,
  type WizardPort,
  type WizardRule,
  type WizardSpec,
} from "@/lib/wizards/networkPolicy";

/**
 * D12 — NetworkPolicy ingress/egress wizard.
 *
 * Constructs a networking.k8s.io/v1 NetworkPolicy from a forms-based
 * UI, shows a live YAML preview, and applies via the existing
 * `apply_resource` Tauri command. The form intentionally covers the
 * common subset (matchLabels selectors + ipBlock CIDRs + ports) — see
 * `lib/wizards/networkPolicy.ts` for the rationale and the testable
 * manifest builder.
 */
export function NetworkPolicyWizard() {
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
    namespace: namespaces[0] ?? "default",
    podSelector: [],
    ingress: { enabled: true, rules: [emptyRule()] },
    egress: { enabled: false, rules: [] },
  }));
  const [busy, setBusy] = useState(false);
  const [appliedDryRun, setAppliedDryRun] = useState(false);

  const errors = useMemo(() => validate(spec), [spec]);
  const yaml = useMemo(
    () => manifestToYaml(finalizeManifest(buildNetworkPolicyManifest(spec))),
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
      await k8s.applyResource(
        spec.namespace.trim(),
        "networkpolicy",
        spec.name.trim(),
        yaml,
        dryRun,
        context || undefined,
      );
      if (dryRun) {
        setAppliedDryRun(true);
        toast.success("dry-run accepted by API server");
      } else {
        toast.success(`NetworkPolicy ${spec.name} applied`);
        navigate(`/cluster/${encodeURIComponent(context)}/workloads`);
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
        title="New NetworkPolicy"
        description="Build a networking.k8s.io/v1 NetworkPolicy. The preview on the right is what gets applied."
        icon={<Network className="size-4" />}
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                navigate(`/cluster/${encodeURIComponent(context)}/workloads`)
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
        {/* ── Form ───────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4">
          <SectionPanel>
            <h2 className="mds-heading text-[14px] text-text-primary mb-3">
              Identity
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="name">
                <Input
                  value={spec.name}
                  onChange={(e) =>
                    setSpec((s) => ({ ...s, name: e.target.value }))
                  }
                  placeholder="allow-internal"
                />
              </Field>
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
            </div>
          </SectionPanel>

          <SectionPanel>
            <h2 className="mds-heading text-[14px] text-text-primary mb-3">
              Applies to which pods?
            </h2>
            <p className="mb-2 text-[11px] text-text-muted">
              Leave empty to select all pods in the namespace. Each row is an
              AND-combined matchLabel.
            </p>
            <LabelEditor
              labels={spec.podSelector}
              onChange={(podSelector) =>
                setSpec((s) => ({ ...s, podSelector }))
              }
            />
          </SectionPanel>

          <DirectionPanel
            title="Ingress"
            description="Empty rule list = deny all incoming traffic. Add rules to allow specific peers."
            direction="ingress"
            spec={spec}
            setSpec={setSpec}
          />
          <DirectionPanel
            title="Egress"
            description="Empty rule list = deny all outgoing traffic. Add rules to allow specific destinations."
            direction="egress"
            spec={spec}
            setSpec={setSpec}
          />

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

        {/* ── YAML preview ──────────────────────────────────────────── */}
        <div>
          <SectionPanel className="sticky top-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="mds-heading text-[14px] text-text-primary">
                Manifest preview
              </h2>
              <span className="font-mono text-[10px] text-text-muted">
                networking.k8s.io/v1
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

function emptyRule(): WizardRule {
  return { peers: [], ports: [] };
}

function emptyPeer(): WizardPeer {
  return {};
}

function emptyPort(): WizardPort {
  return { protocol: "TCP", port: "" };
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

function LabelEditor({
  labels,
  onChange,
}: {
  labels: Label[];
  onChange: (labels: Label[]) => void;
}) {
  return (
    <div className="space-y-2">
      {labels.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={l.key}
            placeholder="key (e.g. app)"
            onChange={(e) => {
              const next = [...labels];
              next[i] = { ...l, key: e.target.value };
              onChange(next);
            }}
            className="flex-1"
          />
          <span className="text-text-muted">=</span>
          <Input
            value={l.value}
            placeholder="value"
            onChange={(e) => {
              const next = [...labels];
              next[i] = { ...l, value: e.target.value };
              onChange(next);
            }}
            className="flex-1"
          />
          <button
            type="button"
            onClick={() => onChange(labels.filter((_, j) => j !== i))}
            className="rounded p-1 text-text-muted hover:bg-elevated hover:text-danger"
            aria-label="remove label"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...labels, { key: "", value: "" }])}
        className="inline-flex items-center gap-1 text-[11px] text-accent-primary hover:underline"
      >
        <Plus className="size-3" /> add label
      </button>
    </div>
  );
}

function DirectionPanel({
  title,
  description,
  direction,
  spec,
  setSpec,
}: {
  title: string;
  description: string;
  direction: "ingress" | "egress";
  spec: WizardSpec;
  setSpec: React.Dispatch<React.SetStateAction<WizardSpec>>;
}) {
  const slot = spec[direction];
  return (
    <SectionPanel>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h2 className="mds-heading text-[14px] text-text-primary">{title}</h2>
          <p className="text-[11px] text-text-muted">{description}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[12px] text-text-secondary">
          <input
            type="checkbox"
            checked={slot.enabled}
            onChange={(e) =>
              setSpec((s) => ({
                ...s,
                [direction]: { ...slot, enabled: e.target.checked },
              }))
            }
          />
          enable
        </label>
      </div>
      {slot.enabled && (
        <div className="space-y-3">
          {slot.rules.map((rule, ri) => (
            <RuleEditor
              key={ri}
              direction={direction}
              rule={rule}
              onChange={(next) =>
                setSpec((s) => ({
                  ...s,
                  [direction]: {
                    ...s[direction],
                    rules: s[direction].rules.map((r, i) => (i === ri ? next : r)),
                  },
                }))
              }
              onRemove={() =>
                setSpec((s) => ({
                  ...s,
                  [direction]: {
                    ...s[direction],
                    rules: s[direction].rules.filter((_, i) => i !== ri),
                  },
                }))
              }
            />
          ))}
          <button
            type="button"
            onClick={() =>
              setSpec((s) => ({
                ...s,
                [direction]: {
                  ...s[direction],
                  rules: [...s[direction].rules, emptyRule()],
                },
              }))
            }
            className="inline-flex items-center gap-1 text-[11px] text-accent-primary hover:underline"
          >
            <Plus className="size-3" /> add rule
          </button>
        </div>
      )}
    </SectionPanel>
  );
}

function RuleEditor({
  direction,
  rule,
  onChange,
  onRemove,
}: {
  direction: "ingress" | "egress";
  rule: WizardRule;
  onChange: (next: WizardRule) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded border border-border-subtle bg-elevated p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-text-muted">
          rule
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 text-text-muted hover:bg-surface hover:text-danger"
          aria-label="remove rule"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      <div className="space-y-2">
        <div>
          <span className="text-[11px] text-text-muted">
            {direction === "ingress" ? "from" : "to"} (peers)
          </span>
          <PeerList
            peers={rule.peers}
            onChange={(peers) => onChange({ ...rule, peers })}
          />
        </div>
        <div>
          <span className="text-[11px] text-text-muted">ports</span>
          <PortList
            ports={rule.ports}
            onChange={(ports) => onChange({ ...rule, ports })}
          />
        </div>
      </div>
    </div>
  );
}

function PeerList({
  peers,
  onChange,
}: {
  peers: WizardPeer[];
  onChange: (peers: WizardPeer[]) => void;
}) {
  return (
    <div className="space-y-2">
      {peers.map((p, i) => (
        <PeerRow
          key={i}
          peer={p}
          onChange={(next) => onChange(peers.map((q, j) => (j === i ? next : q)))}
          onRemove={() => onChange(peers.filter((_, j) => j !== i))}
        />
      ))}
      <button
        type="button"
        onClick={() => onChange([...peers, emptyPeer()])}
        className="inline-flex items-center gap-1 text-[11px] text-accent-primary hover:underline"
      >
        <Plus className="size-3" /> add peer
      </button>
    </div>
  );
}

function PeerRow({
  peer,
  onChange,
  onRemove,
}: {
  peer: WizardPeer;
  onChange: (next: WizardPeer) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded border border-border-subtle bg-surface p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] text-text-muted">peer</span>
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 text-text-muted hover:bg-elevated hover:text-danger"
          aria-label="remove peer"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-1.5 text-[11px] sm:grid-cols-2">
        <Input
          placeholder="pod label key"
          value={peer.podLabel?.key ?? ""}
          onChange={(e) =>
            onChange({
              ...peer,
              podLabel: { key: e.target.value, value: peer.podLabel?.value ?? "" },
            })
          }
        />
        <Input
          placeholder="pod label value"
          value={peer.podLabel?.value ?? ""}
          onChange={(e) =>
            onChange({
              ...peer,
              podLabel: { key: peer.podLabel?.key ?? "", value: e.target.value },
            })
          }
        />
        <Input
          placeholder="namespace label key"
          value={peer.namespaceLabel?.key ?? ""}
          onChange={(e) =>
            onChange({
              ...peer,
              namespaceLabel: {
                key: e.target.value,
                value: peer.namespaceLabel?.value ?? "",
              },
            })
          }
        />
        <Input
          placeholder="namespace label value"
          value={peer.namespaceLabel?.value ?? ""}
          onChange={(e) =>
            onChange({
              ...peer,
              namespaceLabel: {
                key: peer.namespaceLabel?.key ?? "",
                value: e.target.value,
              },
            })
          }
        />
        <Input
          className="sm:col-span-2"
          placeholder="ipBlock CIDR (e.g. 10.0.0.0/8)"
          value={peer.cidr ?? ""}
          onChange={(e) => onChange({ ...peer, cidr: e.target.value })}
        />
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-text-muted">
        <Globe className="size-3" /> empty fields are ignored
      </div>
    </div>
  );
}

function PortList({
  ports,
  onChange,
}: {
  ports: WizardPort[];
  onChange: (ports: WizardPort[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      {ports.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <select
            value={p.protocol}
            onChange={(e) =>
              onChange(
                ports.map((q, j) =>
                  j === i ? { ...q, protocol: e.target.value as WizardPort["protocol"] } : q,
                ),
              )
            }
            className="h-8 rounded-control border border-border-default bg-elevated px-2 text-xs text-text-primary"
          >
            <option value="TCP">TCP</option>
            <option value="UDP">UDP</option>
            <option value="SCTP">SCTP</option>
          </select>
          <Input
            value={p.port}
            placeholder="port (e.g. 80 or http)"
            onChange={(e) =>
              onChange(
                ports.map((q, j) =>
                  j === i ? { ...q, port: e.target.value } : q,
                ),
              )
            }
            className="flex-1"
          />
          <button
            type="button"
            onClick={() => onChange(ports.filter((_, j) => j !== i))}
            className="rounded p-1 text-text-muted hover:bg-elevated hover:text-danger"
            aria-label="remove port"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...ports, emptyPort()])}
        className={cn(
          "inline-flex items-center gap-1 text-[11px] text-accent-primary hover:underline",
        )}
      >
        <Plus className="size-3" /> add port
      </button>
    </div>
  );
}
