export type ChangeHistoryAction =
  | "apply"
  | "delete"
  | "restart"
  | "scale"
  | "set-image"
  | "trigger"
  | "helm-install"
  | "helm-upgrade"
  | "helm-rollback"
  | "helm-uninstall"
  | "argocd-sync"
  | "argocd-rollback"
  | "argocd-terminate";

export type ChangeHistoryStatus = "success" | "failure";

export type ChangeHistoryTarget = {
  kind: string;
  namespace: string;
  name: string;
  context: string;
};

export type ChangeHistoryEvent = {
  id: string;
  action: ChangeHistoryAction;
  target: ChangeHistoryTarget;
  timestamp: number;
  status: ChangeHistoryStatus;
  summary: string;
  error?: string;
  details?: Record<string, unknown>;
};

export type ChangeHistoryEventInput = {
  action: ChangeHistoryAction;
  target: ChangeHistoryTarget;
  status: ChangeHistoryStatus;
  summary?: string;
  error?: unknown;
  details?: Record<string, unknown>;
};

export type ChangeHistoryFilters = {
  context?: string;
  namespace?: string;
  action?: ChangeHistoryAction | "all";
  status?: ChangeHistoryStatus | "all";
  search?: string;
};

const MAX_SUMMARY_CHARS = 180;
const MAX_ERROR_CHARS = 240;
const MAX_DETAIL_STRING_CHARS = 500;
const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|pwd|token|secret|credential|credentials|clientSecret|client_secret|privateKey|private_key|bearer|authorization|auth)/i;
const SECRET_MANIFEST_PATTERN =
  /(^|\n)\s*kind\s*:\s*Secret\s*(\n|$)|(^|\n)\s*type\s*:\s*kubernetes\.io\//i;

export function buildChangeHistoryEvent(
  input: ChangeHistoryEventInput,
  timestamp: number = Date.now(),
  makeId: () => string = defaultChangeHistoryId,
): ChangeHistoryEvent {
  const target = normalizeTarget(input.target);
  const summary =
    clampText(input.summary?.trim() || defaultSummary(input.action, target), MAX_SUMMARY_CHARS) ||
    defaultSummary(input.action, target);
  const event: ChangeHistoryEvent = {
    id: makeId(),
    action: input.action,
    target,
    timestamp,
    status: input.status,
    summary,
  };
  const error = errorMessage(input.error);
  if (error) event.error = clampText(error, MAX_ERROR_CHARS);
  const details = redactChangeHistoryDetails(input.details, target);
  if (details && Object.keys(details).length > 0) event.details = details;
  return event;
}

export function defaultChangeHistoryId(): string {
  return `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeTarget(target: ChangeHistoryTarget): ChangeHistoryTarget {
  return {
    kind: normalizeKind(target.kind),
    namespace: target.namespace.trim(),
    name: target.name.trim(),
    context: target.context.trim(),
  };
}

export function redactChangeHistoryDetails(
  details: Record<string, unknown> | undefined,
  target: ChangeHistoryTarget,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const normalizedTarget = normalizeTarget(target);
  const redacted = redactValue(details, normalizedTarget, "") as Record<string, unknown>;
  return redacted;
}

export function filterChangeHistoryEvents(
  events: ChangeHistoryEvent[],
  filters: ChangeHistoryFilters,
): ChangeHistoryEvent[] {
  const context = filters.context?.trim();
  const namespace = filters.namespace?.trim();
  const action = filters.action && filters.action !== "all" ? filters.action : "";
  const status = filters.status && filters.status !== "all" ? filters.status : "";
  const search = filters.search?.trim().toLowerCase() ?? "";
  return events.filter((event) => {
    if (context && event.target.context !== context) return false;
    if (namespace && event.target.namespace !== namespace) return false;
    if (action && event.action !== action) return false;
    if (status && event.status !== status) return false;
    if (!search) return true;
    return searchableText(event).includes(search);
  });
}

export function changeHistoryResourceHref(event: ChangeHistoryEvent): string | null {
  const { context, kind, namespace, name } = event.target;
  if (!context || !kind || !name) return null;
  const clusterBase = `/cluster/${encodeURIComponent(context)}`;
  if (kind === "helmrelease") return `${clusterBase}/helm`;
  if (kind === "argocdapplication") {
    const params = new URLSearchParams({ app: `${namespace}/${name}` });
    return `${clusterBase}/argocd?${params.toString()}`;
  }
  const slug = kindToRouteSlug(kind);
  const params = new URLSearchParams();
  if (namespace) params.set("ns", namespace);
  params.set("q", name);
  return `${clusterBase}/workloads/${slug}?${params.toString()}`;
}

export function parsePersistedChangeHistoryEvents(raw: string | null): ChangeHistoryEvent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): ChangeHistoryEvent[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<ChangeHistoryEvent>;
      if (
        typeof candidate.id !== "string" ||
        !isChangeHistoryAction(candidate.action) ||
        !isChangeHistoryStatus(candidate.status) ||
        typeof candidate.timestamp !== "number" ||
        typeof candidate.summary !== "string" ||
        !candidate.target ||
        typeof candidate.target !== "object"
      ) {
        return [];
      }
      const target = candidate.target as Partial<ChangeHistoryTarget>;
      if (
        typeof target.kind !== "string" ||
        typeof target.namespace !== "string" ||
        typeof target.name !== "string" ||
        typeof target.context !== "string"
      ) {
        return [];
      }
      const id = candidate.id;
      const event = buildChangeHistoryEvent(
        {
          action: candidate.action,
          target: {
            kind: target.kind,
            namespace: target.namespace,
            name: target.name,
            context: target.context,
          },
          status: candidate.status,
          summary: candidate.summary,
          error: candidate.error,
          details:
            candidate.details && typeof candidate.details === "object"
              ? (candidate.details as Record<string, unknown>)
              : undefined,
        },
        candidate.timestamp,
        () => id,
      );
      return [event];
    });
  } catch {
    return [];
  }
}

export function errorMessage(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  return String(error);
}

function redactValue(
  value: unknown,
  target: ChangeHistoryTarget,
  key: string,
): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (isSecretTarget(target) && looksLikeManifest(value)) {
      return "[redacted secret manifest]";
    }
    if (SECRET_MANIFEST_PATTERN.test(value)) return "[redacted secret manifest]";
    return clampText(value, MAX_DETAIL_STRING_CHARS);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(item, target, key));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = redactValue(childValue, target, childKey);
    }
    return out;
  }
  return value;
}

function searchableText(event: ChangeHistoryEvent): string {
  return [
    event.action,
    event.status,
    event.summary,
    event.error,
    event.target.context,
    event.target.namespace,
    event.target.kind,
    event.target.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function defaultSummary(action: ChangeHistoryAction, target: ChangeHistoryTarget): string {
  return `${action} ${target.kind}/${target.name}`;
}

function normalizeKind(kind: string): string {
  return kind.trim().toLowerCase();
}

function clampText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function isSecretTarget(target: ChangeHistoryTarget): boolean {
  return normalizeKind(target.kind) === "secret";
}

function looksLikeManifest(value: string): boolean {
  return /(^|\n)\s*(apiVersion|kind|metadata|data|stringData)\s*:/i.test(value);
}

function kindToRouteSlug(kind: string): string {
  const normalized = normalizeKind(kind);
  const map: Record<string, string> = {
    pod: "pods",
    deployment: "deployments",
    statefulset: "statefulsets",
    daemonset: "daemonsets",
    replicaset: "replicasets",
    replicationcontroller: "replicationcontrollers",
    job: "jobs",
    cronjob: "cronjobs",
    configmap: "configmaps",
    secret: "secrets",
    service: "services",
    ingress: "ingresses",
    networkpolicy: "networkpolicies",
    persistentvolumeclaim: "pvcs",
    persistentvolume: "pvs",
    namespace: "namespaces",
    node: "nodes",
  };
  return map[normalized] ?? `${normalized}s`;
}

function isChangeHistoryAction(value: unknown): value is ChangeHistoryAction {
  return (
    typeof value === "string" &&
    [
      "apply",
      "delete",
      "restart",
      "scale",
      "set-image",
      "trigger",
      "helm-install",
      "helm-upgrade",
      "helm-rollback",
      "helm-uninstall",
      "argocd-sync",
      "argocd-rollback",
      "argocd-terminate",
    ].includes(value)
  );
}

function isChangeHistoryStatus(value: unknown): value is ChangeHistoryStatus {
  return value === "success" || value === "failure";
}
