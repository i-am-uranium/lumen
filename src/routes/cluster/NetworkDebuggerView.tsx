import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  Network,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { ResourceDetailDrawer } from "@/components/ResourceDetailDrawer";
import { LumenPage, PageHeader, SectionPanel } from "@/components/lumen/page";
import { analyzeGatewayRelationships } from "@/lib/networkGateway";
import { k8s } from "@/lib/k8s";
import {
  analyzeNetworkPath,
  type NetworkAnalysisRequest,
  type NetworkDestinationRef,
  type NetworkFinding,
  type NetworkPathAnalysis,
  type NetworkPod,
  type NetworkService,
} from "@/lib/networkDebugger";
import { cn } from "@/lib/utils";

type DrawerResource = { kind: string; namespace: string; name: string };
type DestinationKind = NetworkDestinationRef["kind"];
type SourceMode = "Pod" | "Selector" | "Namespace";

function selectClassName(className?: string): string {
  return cn(
    "h-8 rounded-control border border-border-default bg-app px-2 text-[12px] text-text-primary outline-none",
    className,
  );
}

function parseDestinationPort(value: string): number | string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  return Number.isInteger(numeric) ? numeric : trimmed;
}

function parseLabelSelector(value: string): Record<string, string> {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const [key, ...rest] = part.split("=");
      const value = rest.join("=").trim();
      if (key.trim() && value) acc[key.trim()] = value;
      return acc;
    }, {});
}

function resourceLabel(kind: string, namespace: string, name: string): string {
  return `${kind}/${namespace}/${name}`;
}

function statusTone(severity: NetworkFinding["severity"]): string {
  if (severity === "error") return "border-danger/40 bg-danger-soft text-danger";
  if (severity === "warning") return "border-warning/40 bg-warning-soft text-warning";
  return "border-info/40 bg-info-soft text-info";
}

function FindingIcon({ severity }: { severity: NetworkFinding["severity"] }) {
  if (severity === "error") return <XCircle className="size-4" />;
  if (severity === "warning") return <AlertTriangle className="size-4" />;
  return <CheckCircle2 className="size-4" />;
}

function ResourceButton({
  kind,
  namespace,
  name,
  onOpen,
}: {
  kind: string;
  namespace: string;
  name: string;
  onOpen: (resource: DrawerResource) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen({ kind, namespace, name })}
      className="inline-flex h-7 items-center rounded-control border border-border-default bg-elevated px-2 font-mono text-[11px] text-text-secondary hover:border-accent-primary/50 hover:text-text-primary"
      title={`open ${resourceLabel(kind, namespace, name)}`}
    >
      {kind}/{name}
    </button>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <SectionPanel>
      <div className="flex min-h-44 items-center justify-center text-center text-[13px] text-text-secondary">
        {message}
      </div>
    </SectionPanel>
  );
}

function FindingsPanel({ analysis }: { analysis: NetworkPathAnalysis | null }) {
  const findings = analysis?.findings ?? [];
  if (!analysis) {
    return <EmptyPanel message="select a source and destination to run a local path analysis." />;
  }
  if (findings.length === 0) {
    return (
      <SectionPanel>
        <div className="flex items-center gap-3 rounded-control border border-success/35 bg-success-soft px-3 py-3 text-[13px] text-success">
          <CheckCircle2 className="size-4 shrink-0" />
          No obvious selector, endpoint, or ingress NetworkPolicy blockers were found.
        </div>
      </SectionPanel>
    );
  }
  return (
    <SectionPanel className="space-y-2">
      {findings.map((finding) => (
        <div
          key={`${finding.severity}:${finding.title}`}
          className={cn(
            "flex gap-3 rounded-control border px-3 py-3 text-[13px]",
            statusTone(finding.severity),
          )}
        >
          <span className="shrink-0 pt-0.5">
            <FindingIcon severity={finding.severity} />
          </span>
          <div className="min-w-0">
            <div className="font-medium">{finding.title}</div>
            <div className="mt-1 text-[12px] opacity-85">{finding.detail}</div>
          </div>
        </div>
      ))}
    </SectionPanel>
  );
}

function ServicePanel({
  analysis,
  onOpen,
}: {
  analysis: NetworkPathAnalysis | null;
  onOpen: (resource: DrawerResource) => void;
}) {
  const service = analysis?.service;
  if (!service) return null;
  return (
    <SectionPanel>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            service route
          </div>
          <h2 className="mt-1 text-base font-semibold text-text-primary">
            {service.service.namespace}/{service.service.name}
          </h2>
          <p className="mt-1 text-[12px] text-text-secondary">
            selector {formatSelector(service.service.selector)} · {service.diagnosis}
          </p>
        </div>
        <ResourceButton
          kind="service"
          namespace={service.service.namespace}
          name={service.service.name}
          onOpen={onOpen}
        />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <Metric label="backing pods" value={String(service.backingPods.length)} />
        <Metric label="ready endpoints" value={String(service.readyEndpoints.length)} />
        <Metric label="not ready endpoints" value={String(service.notReadyEndpoints.length)} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div>
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            pods selected by Service
          </div>
          <div className="flex flex-wrap gap-2">
            {service.backingPods.length === 0 ? (
              <span className="text-[12px] text-text-muted">none</span>
            ) : (
              service.backingPods.map((pod) => (
                <ResourceButton
                  key={pod.name}
                  kind="pod"
                  namespace={pod.namespace}
                  name={pod.name}
                  onOpen={onOpen}
                />
              ))
            )}
          </div>
        </div>
        <div>
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            port mapping
          </div>
          <div className="space-y-1">
            {service.portMappings.map((port) => (
              <div
                key={`${port.name ?? "port"}:${port.servicePort}:${port.targetPort}`}
                className="rounded-control border border-border-default bg-app px-3 py-2 font-mono text-[12px] text-text-secondary"
              >
                {port.name ?? "unnamed"} · {port.protocol} · :{port.servicePort} →{" "}
                {port.resolvedTargetPort ?? port.targetPort}
              </div>
            ))}
          </div>
        </div>
      </div>
    </SectionPanel>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-control border border-border-default bg-app px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function IngressPanel({
  analysis,
  onOpen,
}: {
  analysis: NetworkPathAnalysis | null;
  onOpen: (resource: DrawerResource) => void;
}) {
  if (!analysis?.ingress) return null;
  const { ingress, matchedBackend } = analysis.ingress;
  return (
    <SectionPanel>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            ingress mapping
          </div>
          <h2 className="mt-1 text-base font-semibold text-text-primary">
            {ingress.namespace}/{ingress.name}
          </h2>
          <p className="mt-1 text-[12px] text-text-secondary">
            {matchedBackend
              ? `${matchedBackend.host ?? "*"} ${matchedBackend.path} → service/${matchedBackend.serviceName}`
              : "no selected rule matched the requested host/path"}
          </p>
        </div>
        <ResourceButton
          kind="ingress"
          namespace={ingress.namespace}
          name={ingress.name}
          onOpen={onOpen}
        />
      </div>
    </SectionPanel>
  );
}

function NetworkPolicyPanel({
  analysis,
  onOpen,
}: {
  analysis: NetworkPathAnalysis | null;
  onOpen: (resource: DrawerResource) => void;
}) {
  const policy = analysis?.networkPolicy;
  if (!policy) return null;
  const tone =
    policy.verdict === "blocked"
      ? "text-danger"
      : policy.verdict === "unknown"
        ? "text-warning"
        : "text-success";
  return (
    <SectionPanel>
      <div className="flex items-start gap-3">
        <ShieldAlert className={cn("mt-1 size-5 shrink-0", tone)} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            ingress and egress NetworkPolicy
          </div>
          <h2 className={cn("mt-1 text-base font-semibold", tone)}>
            {policy.verdict === "allowed" ? "allowed-by-model" : policy.verdict}
          </h2>
          <p className="mt-1 text-[12px] text-text-secondary">
            {policy.reason} This is an approximation based on Kubernetes label selectors,
            selected ports, and local namespace labels.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {policy.policies.length === 0 ? (
              <span className="text-[12px] text-text-muted">no selecting policies</span>
            ) : (
              policy.policies.map((item) => (
                <ResourceButton
                  key={`${item.namespace}/${item.name}`}
                  kind="networkpolicy"
                  namespace={item.namespace}
                  name={item.name}
                  onOpen={onOpen}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </SectionPanel>
  );
}

function formatSelector(selector: Record<string, string>): string {
  const entries = Object.entries(selector);
  if (entries.length === 0) return "<none>";
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

function sortedPods(pods: NetworkPod[]): NetworkPod[] {
  return [...pods].sort(
    (a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name),
  );
}

function sortedServices(services: NetworkService[]): NetworkService[] {
  return [...services].sort(
    (a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name),
  );
}

export function NetworkDebuggerView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const [searchParams, setSearchParams] = useSearchParams();
  const namespace = searchParams.get("ns") || "default";
  const requestedService = searchParams.get("service") || "";
  const [sourceNamespaceInput, setSourceNamespace] = useState("");
  const sourceNamespace = sourceNamespaceInput || namespace;
  const [sourceMode, setSourceMode] = useState<SourceMode>("Pod");
  const [sourcePodName, setSourcePodName] = useState("");
  const [sourceSelector, setSourceSelector] = useState("app=");
  const [destinationKind, setDestinationKind] = useState<DestinationKind>("Service");
  const [destinationName, setDestinationName] = useState("");
  const [destinationPort, setDestinationPort] = useState("");
  const [ingressHost, setIngressHost] = useState("");
  const [ingressPath, setIngressPath] = useState("/");
  const [drawerContext, setDrawerContext] = useState(context);
  const openResource = (resource: DrawerResource) => { setDrawerContext(context); setDrawerResource(resource); };
  const [drawerResource, setDrawerResource] = useState<DrawerResource | null>(null);

  const namespaces = useQuery({
    queryKey: ["k8s", "namespaces", context],
    queryFn: () => k8s.listNamespaces(context || undefined),
    enabled: !!context,
    staleTime: 60_000,
  });
  const snapshot = useQuery({
    queryKey: ["k8s", "network-debugger", context, namespace],
    queryFn: () => k8s.networkDebugSnapshot(namespace, context || undefined),
    enabled: !!context && !!namespace,
    staleTime: 15_000,
  });

  const sourceSnapshot = useQuery({
    queryKey: ["k8s", "network-debugger", context, sourceNamespace],
    queryFn: () => k8s.networkDebugSnapshot(sourceNamespace, context || undefined),
    enabled: !!context && !!sourceNamespace,
    staleTime: 15_000,
  });
  const combined = useMemo(() => {
    if (!snapshot.data) return undefined;
    if (sourceNamespace === namespace) return snapshot.data;
    const source = sourceSnapshot.data;
    return {
      ...snapshot.data,
      loadedNamespaces: [...(snapshot.data.loadedNamespaces ?? [namespace]), ...(source?.loadedNamespaces ?? [])],
      namespaces: [...snapshot.data.namespaces, ...(source?.namespaces ?? [])],
      pods: [...snapshot.data.pods, ...(source?.pods ?? [])],
      services: [...snapshot.data.services, ...(source?.services ?? [])],
      endpoints: [...snapshot.data.endpoints, ...(source?.endpoints ?? [])],
      endpointSlices: [...snapshot.data.endpointSlices, ...(source?.endpointSlices ?? [])],
      networkPolicies: [...snapshot.data.networkPolicies, ...(source?.networkPolicies ?? [])],
      gatewayResources: [...(snapshot.data.gatewayResources ?? []), ...(source?.gatewayResources ?? [])],
      unavailable: { ...snapshot.data.unavailable, ...source?.unavailable, ...(!source || sourceSnapshot.error ? { [`${sourceNamespace}/networkPolicies`]: sourceSnapshot.error ? String(sourceSnapshot.error) : "Source namespace is loading or unavailable." } : {}) },
    };
  }, [snapshot.data, sourceSnapshot.data, sourceSnapshot.error, namespace, sourceNamespace]);
  const sourcePods = useMemo(() => sortedPods(sourceSnapshot.data?.pods ?? []), [sourceSnapshot.data]);
  const gatewayEvidence = useMemo(() => combined ? analyzeGatewayRelationships(combined) : [], [combined]);
  useEffect(() => { setDrawerResource(null); setSourcePodName(""); }, [context, sourceNamespace]);

  const pods = useMemo(() => sortedPods(snapshot.data?.pods ?? []), [snapshot.data]);
  const services = useMemo(
    () => sortedServices(snapshot.data?.services ?? []),
    [snapshot.data],
  );
  const ingresses = useMemo(
    () => [...(snapshot.data?.ingresses ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [snapshot.data],
  );

  useEffect(() => {
    if (!snapshot.data) return;
    if (!sourcePodName && sourcePods[0]) setSourcePodName(sourcePods[0].name);
    if (
      requestedService &&
      !destinationName &&
      services.some((service) => service.name === requestedService)
    ) {
      setDestinationKind("Service");
      setDestinationName(requestedService);
      return;
    }
    if (destinationKind === "Service" && !services.some((service) => service.name === destinationName)) {
      setDestinationName(services[0]?.name ?? "");
    } else if (destinationKind === "Pod" && !pods.some((pod) => pod.name === destinationName)) {
      setDestinationName(pods[0]?.name ?? "");
    } else if (
      destinationKind === "Ingress" &&
      !ingresses.some((ingress) => ingress.name === destinationName)
    ) {
      setDestinationName(ingresses[0]?.name ?? "");
    }
  }, [
    destinationKind,
    destinationName,
    ingresses,
    pods,
    requestedService,
    services,
    snapshot.data,
    sourcePodName,
    sourcePods,
  ]);

  const analysis = useMemo(() => {
    if (!combined || !destinationName) return null;
    let destination: NetworkDestinationRef;
    if (destinationKind === "Service") {
      destination = {
        kind: "Service",
        namespace,
        name: destinationName,
        port: parseDestinationPort(destinationPort),
      };
    } else if (destinationKind === "Pod") {
      destination = {
        kind: "Pod",
        namespace,
        name: destinationName,
        port: parseDestinationPort(destinationPort),
      };
    } else {
      destination = {
        kind: "Ingress",
        namespace,
        name: destinationName,
        host: ingressHost.trim() || undefined,
        path: ingressPath.trim() || undefined,
      };
    }
    const request: NetworkAnalysisRequest = {
      source:
        sourceMode === "Pod" && sourcePodName
          ? { kind: "Pod", namespace: sourceNamespace, name: sourcePodName }
          : sourceMode === "Selector"
            ? {
                kind: "Workload",
                namespace: sourceNamespace,
                name: sourceSelector,
                selector: parseLabelSelector(sourceSelector),
              }
            : null,
      destination,
    };
    return analyzeNetworkPath(combined, request);
  }, [
    destinationKind,
    destinationName,
    destinationPort,
    ingressHost,
    ingressPath,
    namespace,
    snapshot.data,
    sourceMode,
    sourcePodName,
    sourceSelector,
    sourceNamespace,
    combined,
  ]);

  const destinationOptions =
    destinationKind === "Service"
      ? services.map((service) => service.name)
      : destinationKind === "Pod"
        ? pods.map((pod) => pod.name)
        : ingresses.map((ingress) => ingress.name);

  const setNamespace = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("ns", next);
    params.delete("service");
    setSearchParams(params);
    setSourcePodName("");
    setDestinationName("");
  };

  return (
    <LumenPage>
      <PageHeader
        eyebrow="network debugger"
        title="why can't A reach B?"
        icon={<Network className="size-4" />}
        description={
          <>
            Local analysis of Services, EndpointSlices, Ingress rules, pod labels,
            and ingress NetworkPolicies for {context}.
          </>
        }
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <input list="network-namespaces" aria-label="target namespace" value={namespace} onChange={event => setNamespace(event.target.value)} className={selectClassName("w-40")} />
            <select
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              className={selectClassName("min-w-40")}
              aria-label="namespace"
            >
              {(namespaces.data ?? [namespace]).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => { void snapshot.refetch(); void sourceSnapshot.refetch(); }}
              disabled={snapshot.isFetching}
              className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
            >
              <RefreshCw className={cn("size-3.5", snapshot.isFetching && "animate-spin")} />
              refresh
            </button>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <SectionPanel className="h-fit space-y-4">
          <div>
            <label className="text-[12px] text-text-secondary" htmlFor="network-source-namespace">source namespace</label>
            <input id="network-source-namespace" list="network-namespaces" value={sourceNamespace} onChange={event => { setSourceNamespace(event.target.value); setSourcePodName(""); }} className={selectClassName("w-full")} />
            <datalist id="network-namespaces">{(namespaces.data ?? [namespace]).map(ns => <option key={ns} value={ns} />)}</datalist>
            <p className="text-[11px] text-text-muted">Target namespace is selected above. Type an accessible namespace if namespace listing is restricted.</p>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
              source type
            </label>
            <select
              value={sourceMode}
              onChange={(event) => setSourceMode(event.target.value as SourceMode)}
              className={selectClassName("w-full")}
            >
              <option value="Pod">Pod</option>
              <option value="Selector">Workload selector</option>
              <option value="Namespace">Namespace</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
              {sourceMode === "Pod"
                ? "source pod"
                : sourceMode === "Selector"
                  ? "source selector"
                  : "source namespace"}
            </label>
            {sourceMode === "Pod" ? (
              <select
                value={sourcePodName}
                onChange={(event) => setSourcePodName(event.target.value)}
                className={selectClassName("w-full")}
              >
                <option value="">no source selected</option>
                {sourcePods.map((pod) => (
                  <option key={pod.name} value={pod.name}>
                    {pod.name}
                  </option>
                ))}
              </select>
            ) : sourceMode === "Selector" ? (
              <input
                value={sourceSelector}
                onChange={(event) => setSourceSelector(event.target.value)}
                placeholder="app=web,tier=frontend"
                className="h-8 w-full rounded-control border border-border-default bg-app px-2 text-[12px] text-text-primary outline-none placeholder:text-text-muted"
              />
            ) : (
              <div className="h-8 rounded-control border border-border-default bg-app px-2 py-1.5 font-mono text-[12px] text-text-secondary">
                namespace/{sourceNamespace}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
                target type
              </label>
              <select
                value={destinationKind}
                onChange={(event) => {
                  setDestinationKind(event.target.value as DestinationKind);
                  setDestinationName("");
                }}
                className={selectClassName("w-full")}
              >
                <option value="Service">Service</option>
                <option value="Pod">Pod</option>
                <option value="Ingress">Ingress</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
                target
              </label>
              <select
                value={destinationName}
                onChange={(event) => setDestinationName(event.target.value)}
                className={selectClassName("w-full")}
              >
                <option value="">select target</option>
                {destinationOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {destinationKind !== "Ingress" ? (
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
                port
              </label>
              <input
                value={destinationPort}
                onChange={(event) => setDestinationPort(event.target.value)}
                placeholder="any, 80, or http"
                className="h-8 w-full rounded-control border border-border-default bg-app px-2 text-[12px] text-text-primary outline-none placeholder:text-text-muted"
              />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
                  host
                </label>
                <input
                  value={ingressHost}
                  onChange={(event) => setIngressHost(event.target.value)}
                  placeholder="any host"
                  className="h-8 w-full rounded-control border border-border-default bg-app px-2 text-[12px] text-text-primary outline-none placeholder:text-text-muted"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
                  path
                </label>
                <input
                  value={ingressPath}
                  onChange={(event) => setIngressPath(event.target.value)}
                  placeholder="/"
                  className="h-8 w-full rounded-control border border-border-default bg-app px-2 text-[12px] text-text-primary outline-none placeholder:text-text-muted"
                />
              </div>
            </div>
          )}

          <div className="rounded-control border border-border-default bg-app p-3 text-[12px] text-text-secondary">
            <GitBranch className="mb-2 size-4 text-accent-primary" />
            NetworkPolicy results are best-effort. Lumen evaluates pod and namespace
            selectors locally; CNI-specific behavior, DNS, node routing, and live packet
            drops are outside this MVP.
          </div>
        </SectionPanel>

        <div className="space-y-4">
          {snapshot.error ? (
            <SectionPanel>
              <div className="flex items-start gap-3 text-danger">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div>
                  <div className="text-sm font-medium">failed to load network resources</div>
                  <div className="mt-1 text-[12px] opacity-85">
                    {(snapshot.error as Error).message}
                  </div>
                </div>
              </div>
            </SectionPanel>
          ) : snapshot.isLoading ? (
            <SectionPanel>
              <div className="flex min-h-44 items-center justify-center gap-2 text-[13px] text-text-secondary">
                <RefreshCw className="size-4 animate-spin" />
                loading Services, pods, endpoints, ingresses, and NetworkPolicies...
              </div>
            </SectionPanel>
          ) : !snapshot.data ? (
            <EmptyPanel message="no pods or Services were found in this namespace." />
          ) : (
            <>
              {!analysis && Object.entries(combined?.unavailable ?? {}).map(([resource, error]) => <SectionPanel key={resource}>
                <p className="text-[12px] text-warning">Evidence unavailable: {resource} · {error}</p>
              </SectionPanel>)}
              <FindingsPanel analysis={analysis} />
              {gatewayEvidence.length > 0 && <SectionPanel className="space-y-3">
                <h2 className="text-base font-semibold">Gateway request-path evidence</h2>
                {gatewayEvidence.map((item, index) => <div key={index} className="rounded-control border border-border-default p-3 text-[12px]">
                  <div className="font-medium">{item.title} · {item.outcome}</div>
                  <p className="mt-1 text-text-secondary">{item.detail}</p>
                  <div className="mt-2 flex flex-wrap gap-2">{item.objects.map((obj, i) => <span key={i} className="font-mono text-text-muted">{obj.kind}/{obj.namespace}/{obj.name}</span>)}</div>
                </div>)}
              </SectionPanel>}
              <IngressPanel analysis={analysis} onOpen={openResource} />
              <ServicePanel analysis={analysis} onOpen={openResource} />
              <NetworkPolicyPanel analysis={analysis} onOpen={openResource} />
            </>
          )}
        </div>
      </div>

      <ResourceDetailDrawer
        ctx={context}
        resource={drawerContext === context ? drawerResource : null}
        onClose={() => setDrawerResource(null)}
      />
    </LumenPage>
  );
}
