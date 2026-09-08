export type LabelMap = Record<string, string>;

export type NetworkNamespace = {
  name: string;
  labels: LabelMap;
};

export type NetworkPodPort = {
  name?: string | null;
  containerPort: number;
  protocol?: string | null;
};

export type NetworkPod = {
  name: string;
  namespace: string;
  labels: LabelMap;
  ready: boolean;
  phase?: string | null;
  podIp?: string | null;
  ports: NetworkPodPort[];
};

export type NetworkServicePort = {
  name?: string | null;
  protocol?: string | null;
  port: number;
  targetPort?: number | string | null;
};

export type NetworkService = {
  name: string;
  namespace: string;
  type?: string | null;
  selector: LabelMap;
  ports: NetworkServicePort[];
};

export type NetworkEndpointRef = {
  kind?: string | null;
  name?: string | null;
  namespace?: string | null;
};

export type NetworkEndpointAddress = {
  addresses: string[];
  ready: boolean;
  targetRef?: NetworkEndpointRef | null;
};

export type NetworkEndpointSlice = {
  name: string;
  namespace: string;
  serviceName: string;
  ports: { name?: string | null; protocol?: string | null; port?: number | null }[];
  endpoints: NetworkEndpointAddress[];
};

export type NetworkEndpoints = {
  name: string;
  namespace: string;
  addresses: NetworkEndpointAddress[];
};

export type NetworkIngressBackend = {
  path: string;
  pathType?: string | null;
  serviceName: string;
  servicePort?: number | string | null;
};

export type NetworkIngressRule = {
  host?: string | null;
  paths: NetworkIngressBackend[];
};

export type NetworkIngress = {
  name: string;
  namespace: string;
  className?: string | null;
  rules: NetworkIngressRule[];
};

export type NetworkPolicyPeer = {
  unsupported?: boolean;
  podSelector?: LabelMap | null;
  namespaceSelector?: LabelMap | null;
  ipBlock?: { cidr: string; except?: string[] } | null;
};

export type NetworkPolicyPort = {
  endPort?: number | null;
  protocol?: string | null;
  port?: number | string | null;
};

export type NetworkPolicyIngressRule = {
  from?: NetworkPolicyPeer[] | null;
  ports?: NetworkPolicyPort[] | null;
};

export type NetworkPolicyResource = {
  unsupported?: boolean;
  egress?: { to?: NetworkPolicyPeer[] | null; ports?: NetworkPolicyPort[] | null }[] | null;
  name: string;
  namespace: string;
  podSelector: LabelMap;
  policyTypes?: string[] | null;
  ingress?: NetworkPolicyIngressRule[] | null;
};

export type NetworkDebugSnapshot = {
  loadedNamespaces?: string[];
  unavailable?: Record<string, string>;
  gatewayResources?: import("./networkGateway").GatewayObject[];
  namespaces: NetworkNamespace[];
  pods: NetworkPod[];
  services: NetworkService[];
  endpoints: NetworkEndpoints[];
  endpointSlices: NetworkEndpointSlice[];
  ingresses: NetworkIngress[];
  networkPolicies: NetworkPolicyResource[];
};

export type NetworkSourceRef =
  | { kind: "Pod"; namespace: string; name: string }
  | { kind: "Workload"; namespace: string; name: string; selector: LabelMap };

export type NetworkDestinationRef =
  | { kind: "Service"; namespace: string; name: string; port?: number | string }
  | { kind: "Pod"; namespace: string; name: string; port?: number | string }
  | {
      kind: "Ingress";
      namespace: string;
      name: string;
      host?: string;
      path?: string;
    };

export type NetworkAnalysisRequest = {
  source?: NetworkSourceRef | null;
  destination: NetworkDestinationRef;
};

export type NetworkFinding = {
  severity: "info" | "warning" | "error";
  title: string;
  detail: string;
};

export type ServiceEndpointDiagnosis =
  | "evidence-unavailable"
  | "headless-or-manual"
  | "selector-matches-no-pods"
  | "no-endpoints"
  | "only-not-ready-endpoints"
  | "ready-endpoints";

export type NetworkPortMapping = {
  name: string | null;
  protocol: string;
  servicePort: number;
  targetPort: number | string;
  resolvedTargetPort: number | null;
};

export type NetworkReadyEndpoint = {
  podName: string | null;
  addresses: string[];
  ready: boolean;
};

export type NetworkServiceAnalysis = {
  service: NetworkService;
  selectorMatched: boolean;
  backingPods: NetworkPod[];
  readyEndpoints: NetworkReadyEndpoint[];
  notReadyEndpoints: NetworkReadyEndpoint[];
  portMappings: NetworkPortMapping[];
  diagnosis: ServiceEndpointDiagnosis;
};

export type NetworkIngressMatch = {
  ingressName: string;
  host: string | null;
  path: string;
  pathType: string | null;
  serviceName: string;
  servicePort: number | string | null;
};

export type NetworkIngressAnalysis = {
  ingress: NetworkIngress;
  matchedBackend: NetworkIngressMatch | null;
};

export type NetworkPolicyVerdict = "allowed" | "blocked" | "unknown";

export type NetworkPolicyAnalysis = {
  verdict: NetworkPolicyVerdict;
  approximate: boolean;
  reason: string;
  policies: NetworkPolicyResource[];
  allowingPolicies: NetworkPolicyResource[];
};

export type NetworkPathAnalysis = {
  sourcePod: NetworkPod | null;
  destinationPods: NetworkPod[];
  service: NetworkServiceAnalysis | null;
  ingress: NetworkIngressAnalysis | null;
  networkPolicy: NetworkPolicyAnalysis | null;
  findings: NetworkFinding[];
};

export function labelsMatchSelector(selector: LabelMap, labels: LabelMap): boolean {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function hasSelector(selector: LabelMap): boolean {
  return Object.keys(selector).length > 0;
}

function sameResource(
  resource: { namespace: string; name: string },
  namespace: string,
  name: string,
): boolean {
  return resource.namespace === namespace && resource.name === name;
}

function podByRef(
  pods: NetworkPod[],
  ref: { namespace: string; name: string },
): NetworkPod | null {
  return pods.find((pod) => sameResource(pod, ref.namespace, ref.name)) ?? null;
}

function resolveSourcePod(
  snapshot: NetworkDebugSnapshot,
  source?: NetworkSourceRef | null,
): NetworkPod | null {
  if (!source) return null;
  if (source.kind === "Pod") return podByRef(snapshot.pods, source);
  return (
    snapshot.pods.find(
      (pod) =>
        pod.namespace === source.namespace && labelsMatchSelector(source.selector, pod.labels),
    ) ?? null
  );
}

function normalizeProtocol(protocol?: string | null): string {
  return (protocol || "TCP").toUpperCase();
}

function endpointPodName(endpoint: NetworkEndpointAddress): string | null {
  if (endpoint.targetRef?.kind && endpoint.targetRef.kind !== "Pod") return null;
  return endpoint.targetRef?.name ?? null;
}

function collectEndpointAddresses(
  snapshot: NetworkDebugSnapshot,
  service: NetworkService,
): NetworkEndpointAddress[] {
  const sliceAddresses = snapshot.endpointSlices
    .filter(
      (slice) =>
        slice.namespace === service.namespace && slice.serviceName === service.name &&
        !snapshot.unavailable?.[`${service.namespace}/endpointSlices`],
    )
    .flatMap((slice) => slice.endpoints);
  if (sliceAddresses.length > 0) return sliceAddresses;
  return snapshot.endpoints
    .filter((endpoint) => sameResource(endpoint, service.namespace, service.name) && !snapshot.unavailable?.[`${service.namespace}/endpoints`])
    .flatMap((endpoint) => endpoint.addresses);
}

function resolveNamedTargetPort(
  targetPort: string,
  pods: NetworkPod[],
  protocol: string,
): number | null {
  for (const pod of pods) {
    const match = pod.ports.find(
      (port) =>
        port.name === targetPort && normalizeProtocol(port.protocol) === protocol,
    );
    if (match) return match.containerPort;
  }
  return null;
}

function servicePortMatches(
  port: NetworkServicePort,
  requested?: number | string,
): boolean {
  if (requested === undefined) return true;
  if (typeof requested === "number") return port.port === requested;
  return port.name === requested || String(port.port) === requested;
}

function analyzeService(
  snapshot: NetworkDebugSnapshot,
  service: NetworkService,
  requestedPort?: number | string,
): NetworkServiceAnalysis {
  const backingPods = hasSelector(service.selector)
    ? snapshot.pods
        .filter(
          (pod) =>
            pod.namespace === service.namespace &&
            labelsMatchSelector(service.selector, pod.labels),
        )
        .sort(compareByName)
    : [];
  const endpoints = collectEndpointAddresses(snapshot, service);
  const readyEndpoints = endpoints
    .filter((endpoint) => endpoint.ready)
    .map(endpointToAnalysis)
    .sort(compareEndpoint);
  const notReadyEndpoints = endpoints
    .filter((endpoint) => !endpoint.ready)
    .map(endpointToAnalysis)
    .sort(compareEndpoint);
  const portMappings = service.ports
    .filter((port) => servicePortMatches(port, requestedPort))
    .map((port) => {
      const protocol = normalizeProtocol(port.protocol);
      const targetPort = port.targetPort ?? port.port;
      const resolvedTargetPort =
        typeof targetPort === "number"
          ? targetPort
          : resolveNamedTargetPort(targetPort, backingPods, protocol);
      return {
        name: port.name ?? null,
        protocol,
        servicePort: port.port,
        targetPort,
        resolvedTargetPort,
      };
    });
  // Either API can independently contain useful endpoints (including manually
  // managed EndpointSlices). A failed read cannot establish absence or prove
  // that the visible not-ready endpoints are the only endpoints.
  const endpointEvidenceMissing = snapshot.unavailable?.[`${service.namespace}/endpointSlices`] || snapshot.unavailable?.[`${service.namespace}/endpoints`];
  const incomplete = snapshot.unavailable?.[`${service.namespace}/pods`] || (endpointEvidenceMissing && readyEndpoints.length === 0);
  const diagnosis = incomplete ? "evidence-unavailable" : diagnoseService(service, backingPods, endpoints, readyEndpoints);
  return {
    service,
    selectorMatched: backingPods.length > 0,
    backingPods,
    readyEndpoints,
    notReadyEndpoints,
    portMappings,
    diagnosis,
  };
}

function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

function compareEndpoint(a: NetworkReadyEndpoint, b: NetworkReadyEndpoint): number {
  return (a.podName ?? a.addresses.join(",")).localeCompare(
    b.podName ?? b.addresses.join(","),
  );
}

function endpointToAnalysis(endpoint: NetworkEndpointAddress): NetworkReadyEndpoint {
  return {
    podName: endpointPodName(endpoint),
    addresses: endpoint.addresses,
    ready: endpoint.ready,
  };
}

function diagnoseService(
  service: NetworkService,
  backingPods: NetworkPod[],
  endpoints: NetworkEndpointAddress[],
  readyEndpoints: NetworkReadyEndpoint[],
): ServiceEndpointDiagnosis {
  if (!hasSelector(service.selector)) return "headless-or-manual";
  if (backingPods.length === 0) return "selector-matches-no-pods";
  if (endpoints.length === 0) return "no-endpoints";
  if (readyEndpoints.length === 0) return "only-not-ready-endpoints";
  return "ready-endpoints";
}


function ingressPathMatches(rulePath: string, requestedPath: string): boolean {
  if (!requestedPath) return true;
  if (rulePath === requestedPath) return true;
  if (rulePath === "/") return true;
  return requestedPath.startsWith(rulePath.endsWith("/") ? rulePath : `${rulePath}/`);
}

function findIngressBackend(
  ingress: NetworkIngress,
  host?: string,
  path?: string,
): NetworkIngressMatch | null {
  for (const rule of ingress.rules) {
    if (host && rule.host && rule.host !== host) continue;
    for (const backend of rule.paths) {
      if (path && !ingressPathMatches(backend.path, path)) continue;
      return {
        ingressName: ingress.name,
        host: rule.host ?? null,
        path: backend.path,
        pathType: backend.pathType ?? null,
        serviceName: backend.serviceName,
        servicePort: backend.servicePort ?? null,
      };
    }
  }
  return null;
}

type Match = boolean | "unknown";
function peerMatches(peer: NetworkPolicyPeer, pod: NetworkPod, snapshot: NetworkDebugSnapshot, namespace: string): Match {
  if (peer.unsupported || peer.ipBlock) return "unknown";
  if (!peer.namespaceSelector && !peer.podSelector) return true;
  if (peer.namespaceSelector) {
    const ns = snapshot.namespaces.find((item) => item.name === pod.namespace);
    if (!ns) return "unknown";
    if (!labelsMatchSelector(peer.namespaceSelector, ns.labels)) return false;
  } else if (pod.namespace !== namespace) return false;
  return !peer.podSelector || labelsMatchSelector(peer.podSelector, pod.labels);
}
function portMatches(ports: NetworkPolicyPort[] | null | undefined, target: number | string | null, pod: NetworkPod, protocol: string): Match {
  if (!ports?.length) return true;
  let unknown = false;
  const resolve = (value: number | string | null) => typeof value === "string"
    ? pod.ports.find((p) => p.name === value && normalizeProtocol(p.protocol) === protocol)?.containerPort ?? null : value;
  for (const port of ports) {
    if (normalizeProtocol(port.protocol) !== protocol) continue;
    if (port.port == null) return true;
    const actual = resolve(target), expected = resolve(port.port);
    if (actual == null || expected == null) { unknown = true; continue; }
    if (actual >= expected && actual <= (port.endPort ?? expected)) return true;
  }
  return unknown ? "unknown" : false;
}
function analyzeNetworkPolicies(snapshot: NetworkDebugSnapshot, source: NetworkPod | null, destinations: NetworkPod[], target: number | string | null, protocol = "TCP"): NetworkPolicyAnalysis | null {
  const policies: NetworkPolicyResource[] = [], allowingPolicies: NetworkPolicyResource[] = [];
  const result = (verdict: NetworkPolicyVerdict, reason: string): NetworkPolicyAnalysis => ({ verdict, reason, policies: [...new Set(policies)], allowingPolicies: [...new Set(allowingPolicies)], approximate: true });
  if (!destinations.length || !source) return result("unknown", "Select an observed source pod and destination pods to evaluate both ingress and egress.");
  const direction = (isolated: NetworkPod, peer: NetworkPod, destination: NetworkPod, kind: "Ingress" | "Egress"): NetworkPolicyVerdict => {
    if (snapshot.unavailable?.[`${isolated.namespace}/networkPolicies`]) return "unknown";
    const selected = snapshot.networkPolicies.filter(p => p.namespace === isolated.namespace && (p.unsupported || labelsMatchSelector(p.podSelector, isolated.labels)) &&
      (p.policyTypes?.length ? p.policyTypes.includes(kind) : kind === "Ingress" || !!p.egress?.length));
    policies.push(...selected);
    if (!selected.length) return "allowed";
    let unknown = false;
    for (const policy of selected) {
      if (policy.unsupported) { unknown = true; continue; }
      const rules = kind === "Ingress" ? policy.ingress : policy.egress?.map(r => ({ from: r.to, ports: r.ports }));
      for (const rule of rules ?? []) {
        const port = portMatches(rule.ports, target, destination, protocol);
        if (port === false) continue;
        const matches = rule.from?.length ? rule.from.map(p => peerMatches(p, peer, snapshot, policy.namespace)) : [true];
        if (port === true && matches.includes(true)) { allowingPolicies.push(policy); return "allowed"; }
        if ((port === "unknown" && matches.some(m => m !== false)) || matches.includes("unknown")) unknown = true;
      }
    }
    return unknown ? "unknown" : "blocked";
  };
  const verdicts = destinations.map(destination => {
    const ingress = direction(destination, source, destination, "Ingress");
    const egress = direction(source, destination, destination, "Egress");
    return ingress === "blocked" || egress === "blocked" ? "blocked" : ingress === "unknown" || egress === "unknown" ? "unknown" : "allowed";
  });
  const verdict = verdicts.every(v => v === "allowed") ? "allowed" : verdicts.every(v => v === "blocked") ? "blocked" : "unknown";
  return result(verdict, verdict === "allowed" ? "Source egress and destination ingress permit every selected pod in this model. Connectivity remains unverified." : verdict === "blocked" ? "Source egress or destination ingress has no matching allow rule for each destination pod." : "Evidence is unavailable, semantics are unsupported, or destination pod outcomes differ.");
}

function addServiceFindings(
  findings: NetworkFinding[],
  service: NetworkServiceAnalysis,
): void {
  if (!service.portMappings.length) findings.push({ severity: "error", title: "Service port not found", detail: "The requested port is not declared by this Service." });
  if (service.diagnosis === "selector-matches-no-pods") {
    findings.push({
      severity: "error",
      title: "Service selector matches no pods",
      detail: `Selector ${formatSelector(service.service.selector)} does not match any pods in ${service.service.namespace}.`,
    });
  } else if (service.diagnosis === "no-endpoints") {
    findings.push({
      severity: "error",
      title: "Service has no endpoints",
      detail: "The selector matches pods, but Kubernetes has not published any Endpoints or EndpointSlices for this Service.",
    });
  } else if (service.diagnosis === "only-not-ready-endpoints") {
    findings.push({
      severity: "warning",
      title: "Service endpoints are not ready",
      detail: "Endpoint objects exist, but none are currently marked ready.",
    });
  } else if (service.diagnosis === "headless-or-manual") {
    findings.push({
      severity: "info",
      title: "Service has no selector",
      detail: "This Service relies on manually managed endpoints or external routing.",
    });
  }
}

function addNetworkPolicyFindings(
  findings: NetworkFinding[],
  analysis: NetworkPolicyAnalysis | null,
): void {
  if (!analysis) return;
  if (analysis.verdict === "blocked") {
    findings.push({
      severity: "error",
      title: "NetworkPolicy model blocks the path",
      detail: analysis.reason,
    });
  } else if (analysis.verdict === "unknown") {
    findings.push({
      severity: "warning",
      title: "NetworkPolicy result is approximate",
      detail: analysis.reason,
    });
  }
}

function formatSelector(selector: LabelMap): string {
  const entries = Object.entries(selector);
  if (entries.length === 0) return "<none>";
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

export function analyzeNetworkPath(
  snapshot: NetworkDebugSnapshot,
  request: NetworkAnalysisRequest,
): NetworkPathAnalysis {
  const findings: NetworkFinding[] = Object.entries(snapshot.unavailable ?? {}).map(([resource, error]) => ({ severity: "warning", title: `Evidence unavailable: ${resource}`, detail: error }));
  const sourcePod = resolveSourcePod(snapshot, request.source);
  let serviceAnalysis: NetworkServiceAnalysis | null = null;
  let ingressAnalysis: NetworkIngressAnalysis | null = null;
  let destinationPods: NetworkPod[] = [];

  if (request.destination.kind === "Service") {
    const service =
      snapshot.services.find((candidate) =>
        sameResource(candidate, request.destination.namespace, request.destination.name),
      ) ?? null;
    if (service) {
      serviceAnalysis = analyzeService(snapshot, service, request.destination.port);
      destinationPods = serviceAnalysis.backingPods;
      addServiceFindings(findings, serviceAnalysis);
    } else {
      findings.push({
        severity: "error",
        title: "Destination Service not found",
        detail: `${request.destination.namespace}/${request.destination.name} is not in the current snapshot.`,
      });
    }
  } else if (request.destination.kind === "Pod") {
    const pod = podByRef(snapshot.pods, request.destination);
    destinationPods = pod ? [pod] : [];
    if (!pod) {
      findings.push({
        severity: "error",
        title: "Destination pod not found",
        detail: `${request.destination.namespace}/${request.destination.name} is not in the current snapshot.`,
      });
    }
  } else {
    const ingress =
      snapshot.ingresses.find((candidate) =>
        sameResource(candidate, request.destination.namespace, request.destination.name),
      ) ?? null;
    if (ingress) {
      const matchedBackend = findIngressBackend(
        ingress,
        request.destination.host,
        request.destination.path,
      );
      ingressAnalysis = { ingress, matchedBackend };
      if (matchedBackend) {
        const service =
          snapshot.services.find((candidate) =>
            sameResource(candidate, ingress.namespace, matchedBackend.serviceName),
          ) ?? null;
        if (service) {
          serviceAnalysis = analyzeService(
            snapshot,
            service,
            matchedBackend.servicePort ?? undefined,
          );
          destinationPods = serviceAnalysis.backingPods;
          addServiceFindings(findings, serviceAnalysis);
        } else {
          findings.push({
            severity: "error",
            title: "Ingress backend Service not found",
            detail: `${ingress.namespace}/${matchedBackend.serviceName} is referenced by the Ingress but is missing from the snapshot.`,
          });
        }
      } else {
        findings.push({
          severity: "error",
          title: "Ingress rule did not match",
          detail: "No host/path rule on this Ingress matched the selected request.",
        });
      }
    } else {
      findings.push({
        severity: "error",
        title: "Destination Ingress not found",
        detail: `${request.destination.namespace}/${request.destination.name} is not in the current snapshot.`,
      });
    }
  }

  const selectedServicePort = serviceAnalysis?.portMappings.length === 1 ? serviceAnalysis.portMappings[0] : null;
  const policyAnalysis: NetworkPolicyAnalysis | null = serviceAnalysis && !selectedServicePort ? {
    verdict: "unknown",
    reason: serviceAnalysis.portMappings.length > 1
      ? "Select a specific Service port to evaluate its target port and protocol; multiple mappings remain."
      : "Select an observed Service port; the requested port mapping is unavailable.",
    policies: [], allowingPolicies: [], approximate: true,
  } : analyzeNetworkPolicies(
    snapshot,
    sourcePod,
    destinationPods,
    selectedServicePort?.targetPort ?? (request.destination.kind === "Pod" ? request.destination.port ?? null : null),
    selectedServicePort?.protocol ?? "TCP",
  );
  if (policyAnalysis && request.source?.kind === "Workload" && snapshot.pods.filter(p => p.namespace === request.source!.namespace && labelsMatchSelector(request.source!.kind === "Workload" ? request.source!.selector : {}, p.labels)).length > 1) {
    policyAnalysis.verdict = "unknown";
    policyAnalysis.reason = "The source selector matches multiple pods. Select a specific source pod to evaluate its egress and peer labels.";
  }
  if (policyAnalysis && request.destination.kind === "Ingress") {
    policyAnalysis.verdict = "unknown";
    policyAnalysis.reason = "Ingress controller pod identity and address translation are not modeled; the original source pod is not necessarily the backend peer.";
  }
  addNetworkPolicyFindings(findings, policyAnalysis);

  findings.push({ severity: "info", title: "Connectivity remains unknown", detail: "Configuration evidence does not probe DNS, CNI enforcement, load balancers, TLS, or external connectivity." });
  return {
    sourcePod,
    destinationPods,
    service: serviceAnalysis,
    ingress: ingressAnalysis,
    networkPolicy: policyAnalysis,
    findings,
  };
}
