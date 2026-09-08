import { labelsMatchSelector, type NetworkDebugSnapshot, type NetworkService, type NetworkServicePort } from "./networkDebugger";

type Ref = { name: string; namespace?: string; kind?: string; group?: string; sectionName?: string; port?: number };
type Condition = { type: string; status: string; reason?: string; observedGeneration?: number };
export type GatewayObject = {
  kind: string;
  metadata: { name: string; namespace?: string; generation?: number };
  spec?: {
    hostnames?: string[];
    parentRefs?: Ref[];
    listeners?: { name: string; hostname?: string; protocol?: string; port?: number; allowedRoutes?: { namespaces?: { from?: string; selector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] } }; kinds?: { kind: string; group?: string }[] } }[];
    rules?: { matches?: unknown[]; filters?: unknown[]; backendRefs?: (Ref & { weight?: number })[] }[];
    from?: { group: string; kind: string; namespace: string }[];
    to?: { group: string; kind: string; name?: string }[];
  };
  status?: { conditions?: Condition[]; parents?: { parentRef: Ref; conditions?: Condition[] }[]; listeners?: { name: string; conditions?: Condition[] }[] };
};
export type GatewayEvidence = { title: string; outcome: "blocked" | "allowed-by-model" | "unknown"; detail: string; objects: Ref[] };

const protocol = (value?: string | null) => (value || "TCP").toUpperCase();

/** A Service-wide ready endpoint is insufficient for a particular backend port.
 * EndpointSlice port names correspond to Service port names; named target ports
 * resolve independently on each namespace-qualified referenced Pod. */
function backendEndpoints(snapshot: NetworkDebugSnapshot, service: NetworkService, selected: NetworkServicePort): { known: boolean; detail: string; objects: Ref[] } {
  const objects: Ref[] = [];
  const add = (ref: Ref) => { if (!objects.some((item) => item.kind === ref.kind && item.namespace === ref.namespace && item.name === ref.name)) objects.push(ref); };
  if (snapshot.unavailable?.[`${service.namespace}/endpointSlices`]) return { known: false, detail: "EndpointSlice evidence is unavailable; the legacy endpoint snapshot lacks selected port mappings.", objects };
  const slices = snapshot.endpointSlices.filter((slice) => slice.namespace === service.namespace && slice.serviceName === service.name);
  let supported = 0, unresolved = 0;
  for (const slice of slices) {
    const ports = slice.ports.filter((port) => (port.name ?? "") === (selected.name ?? "") && protocol(port.protocol) === protocol(selected.protocol));
    if (!ports.length) continue;
    add({ kind: "EndpointSlice", namespace: slice.namespace, name: slice.name });
    for (const endpoint of slice.endpoints.filter((candidate) => candidate.ready)) {
      const targetRef = endpoint.targetRef;
      const namespace = targetRef?.namespace ?? slice.namespace;
      const pod = targetRef?.kind === "Pod" && !snapshot.unavailable?.[`${namespace}/pods`]
        ? snapshot.pods.find((pod) => pod.namespace === namespace && pod.name === targetRef.name) : undefined;
      const target = selected.targetPort ?? selected.port;
      const expected = typeof target === "number" ? target : pod?.ports.find((port) => port.name === target && protocol(port.protocol) === protocol(selected.protocol))?.containerPort;
      if (!pod || expected == null || !ports.some((port) => port.port != null && port.port === expected)) { unresolved++; continue; }
      supported++;
      add({ kind: "Pod", namespace: pod.namespace, name: pod.name });
    }
  }
  return {
    known: supported > 0 && unresolved === 0,
    detail: `Ready endpoints matching the selected port and referenced pod: ${supported}. Unresolved ready endpoint references or target ports: ${unresolved}.` +
      (supported === 0 ? " No complete selected-port EndpointSlice → Pod chain is established; missing or legacy-only port evidence remains unknown." : ""),
    objects,
  };
}

/** Relationship evidence only: no route selection or controller/data-plane simulation. */
export function analyzeGatewayRelationships(snapshot: NetworkDebugSnapshot): GatewayEvidence[] {
  const objects = snapshot.gatewayResources ?? [];
  const evidence: GatewayEvidence[] = [];
  const ref = (obj: GatewayObject): Ref => ({ kind: obj.kind, name: obj.metadata.name, namespace: obj.metadata.namespace });
  const emit = (title: string, outcome: GatewayEvidence["outcome"], detail: string, refs: Ref[]) => evidence.push({ title, outcome, detail, objects: refs });
  const conditions = (title: string, conditions: Condition[] | undefined, generation: number | undefined, names: string[], refs: Ref[], trusted = true) => {
    for (const name of names) {
      const c = conditions?.find(c => c.type === name);
      emit(`${title}: ${name}`, !trusted || !c || c.observedGeneration !== generation || generation == null ? "unknown" : c.status === "False" ? "blocked" : c.status === "True" ? "allowed-by-model" : "unknown", !c ? "Condition is absent." : c.observedGeneration !== generation ? "Condition observedGeneration is stale or unavailable." : `${c.status}: ${c.reason ?? "no reason provided"}`, refs);
    }
  };
  for (const route of objects.filter(o => o.kind === "HTTPRoute")) {
    const routeNs = route.metadata.namespace ?? "default";
    const parents = route.spec?.parentRefs ?? [];
    if (!parents.length) emit("HTTPRoute has no parent", "blocked", "No Gateway parent is configured.", [ref(route)]);
    for (const parent of parents) {
      const ns = parent.namespace ?? routeNs;
      if ((parent.kind ?? "Gateway") !== "Gateway" || (parent.group ?? "gateway.networking.k8s.io") !== "gateway.networking.k8s.io") {
        emit("Unsupported route parent", "unknown", "Only Gateway parents are modeled.", [ref(route), parent]); continue;
      }
      const gateway = objects.find(o => o.kind === "Gateway" && o.metadata.name === parent.name && o.metadata.namespace === ns);
      if (!gateway) { emit("Gateway parent missing", snapshot.unavailable?.[`${ns}/gateways`] || !snapshot.loadedNamespaces?.includes(ns) ? "unknown" : "blocked", `Gateway ${ns}/${parent.name} is absent from the available snapshot. Add its namespace to the source or target inputs to load it.`, [ref(route), parent]); continue; }
      const refs = [ref(gateway), ref(route)];
      conditions("Gateway", gateway.status?.conditions, gateway.metadata.generation, ["Accepted", "Programmed"], refs);
      const status = route.status?.parents?.find(p => p.parentRef.name === parent.name && (p.parentRef.namespace ?? routeNs) === ns && p.parentRef.sectionName === parent.sectionName && p.parentRef.port === parent.port && (p.parentRef.kind ?? "Gateway") === "Gateway" && (p.parentRef.group ?? "gateway.networking.k8s.io") === "gateway.networking.k8s.io");
      conditions("HTTPRoute parent", status?.conditions, route.metadata.generation, ["Accepted", "ResolvedRefs"], refs, false);
      emit("HTTPRoute controller identity", "unknown", "Parent conditions are observations. GatewayClass controller identity is not loaded, so these conditions cannot establish effective attachment.", refs);
      const listeners = gateway.spec?.listeners?.filter(l => (!parent.sectionName || l.name === parent.sectionName) && (parent.port == null || l.port === parent.port)) ?? [];
      if (!listeners.length) emit("Gateway listener missing", "blocked", "Parent sectionName/port does not identify a listener.", refs);
      for (const listener of listeners) {
        const selection = listener.allowedRoutes?.namespaces;
        const from = selection?.from ?? "Same";
        const labels = snapshot.namespaces.find(n => n.name === routeNs)?.labels;
        const supported = ["HTTP", "HTTPS"].includes(listener.protocol ?? "");
        const allowed = from === "All" || (from === "Same" && ns === routeNs) || (from === "Selector" && labels && labelsMatchSelector(selection?.selector?.matchLabels ?? {}, labels));
        const hostMatches = (a: string, b: string) => a === b || (a.startsWith("*.") && b.endsWith(a.slice(1))) || (b.startsWith("*.") && a.endsWith(b.slice(1)));
        const hostnameAllowed = !listener.hostname || !route.spec?.hostnames?.length || route.spec.hostnames.some(host => hostMatches(host, listener.hostname!));
        const kinds = listener.allowedRoutes?.kinds;
        const kindAllowed = !kinds?.length || kinds.some(k => k.kind === "HTTPRoute" && (k.group ?? "gateway.networking.k8s.io") === "gateway.networking.k8s.io");
        emit(`Listener ${listener.name} → HTTPRoute`, !supported || selection?.selector?.matchExpressions?.length || (from === "Selector" && !labels) ? "unknown" : allowed && kindAllowed && hostnameAllowed ? "allowed-by-model" : "blocked", `Listener protocol ${listener.protocol}; allowedRoutes namespaces ${from}. Hostname intersection ${hostnameAllowed ? "matches" : "does not match"}; TLS and controller behavior remain unverified.`, refs);
        conditions(`Listener ${listener.name}`, gateway.status?.listeners?.find(l => l.name === listener.name)?.conditions, gateway.metadata.generation, ["Accepted", "ResolvedRefs", "Programmed"], refs);
      }
    }
    for (const rule of route.spec?.rules ?? []) {
      emit("HTTPRoute request selection", "unknown", rule.matches?.length || rule.filters?.length ? "Matches and filters require request/controller semantics and are not evaluated." : "Default matching is configured; external connectivity and controller behavior remain unverified.", [ref(route)]);
      for (const backend of rule.backendRefs ?? []) {
        const ns = backend.namespace ?? routeNs;
        const refs = [ref(route), { ...backend, namespace: ns, kind: backend.kind ?? "Service" }];
        if ((backend.kind ?? "Service") !== "Service" || (backend.group ?? "") !== "") { emit("Unsupported backend", "unknown", "Only core Services are modeled.", refs); continue; }
        if (backend.weight === 0) { emit("Backend receives no configured traffic", "allowed-by-model", "Backend weight is zero.", refs); continue; }
        if (ns !== routeNs) {
          const grant = objects.find(o => o.kind === "ReferenceGrant" && o.metadata.namespace === ns && o.spec?.from?.some(f => f.namespace === routeNs && f.kind === "HTTPRoute" && f.group === "gateway.networking.k8s.io") && o.spec?.to?.some(t => t.kind === "Service" && t.group === "" && (!t.name || t.name === backend.name)));
          emit("Cross-namespace ReferenceGrant", grant ? "allowed-by-model" : snapshot.unavailable?.[`${ns}/referencegrants`] || !snapshot.loadedNamespaces?.includes(ns) ? "unknown" : "blocked", grant ? "A matching grant permits this backend reference." : `No matching grant is visible in ${ns}; load the backend namespace to inspect its evidence.`, grant ? [...refs, ref(grant)] : refs);
        }
        const service = snapshot.services.find(s => s.namespace === ns && s.name === backend.name);
        if (!service) { emit("Backend Service missing", snapshot.unavailable?.[`${ns}/services`] || !snapshot.loadedNamespaces?.includes(ns) ? "unknown" : "blocked", `${ns}/${backend.name} is absent from available evidence.`, refs); continue; }
        const ports = service.ports.filter((port) => port.port === backend.port);
        if (backend.port == null || ports.length === 0) { emit("HTTPRoute backend → Service → endpoints → pods", "blocked", `Service ${ns}/${backend.name}:${backend.port ?? "missing port"} has no matching Service port.`, refs); continue; }
        if (ports.length !== 1) { emit("HTTPRoute backend → Service → endpoints → pods", "unknown", `Service ${ns}/${backend.name}:${backend.port} has ambiguous protocol mappings.`, refs); continue; }
        const chain = backendEndpoints(snapshot, service, ports[0]);
        emit("HTTPRoute backend → Service → endpoints → pods", chain.known ? "allowed-by-model" : "unknown", `Service ${ns}/${backend.name}:${backend.port} (${protocol(ports[0].protocol)}). ${chain.detail} This does not prove packet delivery.`, [...refs, ...chain.objects]);
      }
    }
  }
  return evidence;
}
