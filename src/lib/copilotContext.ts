export type CopilotRouteContext = {
  page: string;
  namespace: string;
  resource: string;
  path: string;
  search: string;
};

export type CopilotPromptContextInput = {
  clusterContext: string;
  route: CopilotRouteContext;
  prompt: string;
};

const PAGE_LABELS: Record<string, string> = {
  ai: "AI assistant",
  alerts: "alert inbox",
  argocd: "argocd",
  compare: "cluster compare",
  events: "events",
  logs: "logs",
  metrics: "metrics explorer",
  "network-debugger": "network debugger",
  timeline: "rollout timeline",
  triage: "incident triage",
  workloads: "workloads",
};

export function buildCopilotRouteContext(
  pathname: string,
  search: string,
): CopilotRouteContext {
  const params = new URLSearchParams(search);
  const parts = pathname.split("/").filter(Boolean);
  const pageSlug = parts[2] ?? "overview";
  const page = PAGE_LABELS[pageSlug] ?? pageSlug.replace(/-/g, " ");
  const namespace = params.get("ns") ?? params.get("namespace") ?? "";
  const app = params.get("app") ?? "";
  const kind = params.get("kind") ?? parts[3] ?? "";
  const name = params.get("name") ?? "";

  return {
    page,
    namespace,
    resource: app || formatResource(kind, namespace, name),
    path: pathname,
    search,
  };
}

export function buildCopilotPromptContext({
  clusterContext,
  route,
  prompt,
}: CopilotPromptContextInput): string {
  return [
    "Lumen AI Ops Copilot context:",
    `cluster: ${clusterContext || "unknown"}`,
    `page: ${route.page}`,
    route.namespace ? `namespace: ${route.namespace}` : "",
    route.resource ? `resource: ${route.resource}` : "",
    `operator request: ${prompt.trim()}`,
    "mode: read-only; provide navigation CTAs instead of mutating actions.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatResource(kind: string, namespace: string, name: string): string {
  if (!kind && !name) return "";
  if (!name) return kind;
  return `${kind}/${namespace ? `${namespace}/` : ""}${name}`;
}
