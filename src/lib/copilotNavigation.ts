export type CopilotNavigationIntent =
  | "logs"
  | "argocd-app"
  | "events"
  | "timeline"
  | "search";

export type CopilotCta = {
  id: string;
  label: string;
  description: string;
  to: string;
  intent: CopilotNavigationIntent;
  icon?: string;
  readOnly: true;
};

export type CopilotResolvedTarget = {
  kind: string;
  namespace: string;
  name: string;
};

export function buildLogsCta(
  context: string,
  target: CopilotResolvedTarget,
): CopilotCta {
  const params = new URLSearchParams();
  if (target.namespace) params.set("ns", target.namespace);
  if (target.kind) params.set("kind", target.kind.toLowerCase());
  if (target.name) params.set("name", target.name);

  return {
    id: "open-logs",
    label: `Open logs filtered to ${target.name}`,
    description: "Navigate to Logs with context, namespace, kind, and name prefilled.",
    to: clusterPath(context, "logs", params),
    intent: "logs",
    readOnly: true,
  };
}

export function buildLogsSearchCta(
  context: string,
  search: string,
  namespace?: string,
): CopilotCta {
  const params = new URLSearchParams();
  if (namespace) params.set("ns", namespace);
  if (search.trim()) params.set("grep", search.trim());

  return {
    id: "search-logs",
    label: `Search logs for ${search.trim() || "this text"}`,
    description: "Open Logs with a search filter when no exact workload match is available.",
    to: clusterPath(context, "logs", params),
    intent: "logs",
    readOnly: true,
  };
}

export function buildArgocdAppCta(
  context: string,
  target: CopilotResolvedTarget,
): CopilotCta {
  const params = new URLSearchParams();
  if (target.namespace && target.name) {
    params.set("app", `${target.namespace}/${target.name}`);
  }

  return {
    id: "open-argocd-app",
    label: `Open ${target.name} in ArgoCD`,
    description: "Navigate to the ArgoCD application; sync remains on the existing preflight flow.",
    to: clusterPath(context, "argocd", params),
    intent: "argocd-app",
    readOnly: true,
  };
}

export function buildEventsCta(
  context: string,
  namespace?: string,
  search?: string,
): CopilotCta {
  const params = new URLSearchParams();
  if (namespace) params.set("ns", namespace);
  if (search?.trim()) params.set("q", search.trim());

  return {
    id: "open-events",
    label: "Open related events",
    description: "Navigate to Events for read-only evidence.",
    to: clusterPath(context, "events", params),
    intent: "events",
    readOnly: true,
  };
}

function clusterPath(context: string, page: string, params: URLSearchParams): string {
  const qs = params.toString();
  const base = `/cluster/${encodeURIComponent(context)}/${page}`;
  return qs ? `${base}?${qs}` : base;
}
