import { k8s, type EventSummary, type Health, type WorkloadKind, type WorkloadSummary } from "@/lib/k8s";
import { buildEventsCta, buildLogsTargetCta, buildWorkloadCta, type CopilotCta } from "./copilotNavigation";
import type { CopilotResolvedResource } from "./copilotResourceResolver";

export type CopilotEvidenceFact = {
  id: string;
  severity: "info" | "warning" | "critical";
  label: string;
  value: string;
  detail?: string;
};

export type CopilotEvidenceBundle = {
  target: CopilotResolvedResource;
  health: Health;
  facts: CopilotEvidenceFact[];
  warnings: CopilotEvidenceFact[];
  ctas: CopilotCta[];
  collectedAt: string;
};

export type CopilotEvidenceClient = {
  listPodsFor: (
    namespace: string,
    kind: WorkloadKind,
    name: string,
    context?: string,
  ) => Promise<WorkloadSummary[]>;
  listEventsFor: (
    namespace: string,
    kind: WorkloadKind,
    name: string,
    context?: string,
  ) => Promise<EventSummary[]>;
};

const defaultClient: CopilotEvidenceClient = {
  listPodsFor: (namespace, kind, name, context) =>
    k8s.listPodsFor(namespace, kind, name, context),
  listEventsFor: (namespace, kind, name, context) =>
    k8s.listEventsFor(namespace, kind, name, context),
};

export async function collectCopilotEvidence(
  context: string,
  target: CopilotResolvedResource,
  client: CopilotEvidenceClient = defaultClient,
  now: () => Date = () => new Date(),
): Promise<CopilotEvidenceBundle> {
  if (target.source !== "kubernetes" || !isWorkloadKind(target.kind)) {
    return emptyEvidence(context, target, now);
  }

  const [pods, events] = await Promise.all([
    target.kind === "pod"
      ? Promise.resolve([resolvedTargetAsPod(target)])
      : client.listPodsFor(target.namespace, target.kind, target.name, context),
    client.listEventsFor(target.namespace, target.kind, target.name, context),
  ]);
  const warningEvents = events.filter((event) => event.type_.toLowerCase() === "warning");
  const readyPods = pods.filter((pod) => pod.health === "healthy").length;
  const restartTotal = pods.reduce((sum, pod) => sum + (pod.restart_count ?? 0), 0);
  const highestRestartPod = pods
    .slice()
    .sort((a, b) => (b.restart_count ?? 0) - (a.restart_count ?? 0))[0];
  const health = deriveHealth(target.health, pods, warningEvents);
  const facts: CopilotEvidenceFact[] = [
    {
      id: "target",
      severity: health === "failed" ? "critical" : health === "degraded" ? "warning" : "info",
      label: "Target",
      value: target.displayName,
      detail: target.reasons.join("; "),
    },
    {
      id: "pods",
      severity: readyPods === pods.length ? "info" : "warning",
      label: "Pods",
      value: `${pods.length} total, ${readyPods} ready`,
    },
    {
      id: "restarts",
      severity: restartTotal > 0 ? "warning" : "info",
      label: "Restarts",
      value: `${restartTotal} total`,
    },
  ];
  const warnings: CopilotEvidenceFact[] = [];

  if (highestRestartPod && (highestRestartPod.restart_count ?? 0) > 0) {
    warnings.push({
      id: "highest-restart",
      severity: "warning",
      label: "Highest restart count",
      value: `${highestRestartPod.name}: ${highestRestartPod.restart_count}`,
    });
  }

  for (const event of warningEvents.slice(0, 3)) {
    warnings.push({
      id: `event-${event.reason}-${event.involved_name}`,
      severity: "warning",
      label: event.reason,
      value: event.involved_name,
      detail: event.message,
    });
  }

  return {
    target,
    health,
    facts,
    warnings,
    ctas: [
      buildLogsTargetCta(context, target, target.name),
      buildEventsCta(context, target.namespace, target.name),
      buildWorkloadCta(context, target),
    ],
    collectedAt: now().toISOString(),
  };
}

function emptyEvidence(
  context: string,
  target: CopilotResolvedResource,
  now: () => Date,
): CopilotEvidenceBundle {
  return {
    target,
    health: target.health,
    facts: [
      {
        id: "target",
        severity: "info",
        label: "Target",
        value: target.displayName,
      },
    ],
    warnings: [],
    ctas: [
      buildEventsCta(context, target.namespace, target.name),
      buildWorkloadCta(context, target),
    ],
    collectedAt: now().toISOString(),
  };
}

function deriveHealth(
  targetHealth: Health,
  pods: WorkloadSummary[],
  warningEvents: EventSummary[],
): Health {
  if (targetHealth === "failed" || pods.some((pod) => pod.health === "failed")) {
    return "failed";
  }
  if (
    targetHealth === "degraded" ||
    warningEvents.length > 0 ||
    pods.some((pod) => pod.health !== "healthy")
  ) {
    return "degraded";
  }
  return targetHealth;
}

function resolvedTargetAsPod(target: CopilotResolvedResource): WorkloadSummary {
  return {
    kind: "pod",
    namespace: target.namespace,
    name: target.name,
    ready: target.ready ?? "",
    health: target.health,
    age_seconds: 0,
    labels: {},
  };
}

function isWorkloadKind(kind: CopilotResolvedResource["kind"]): kind is WorkloadKind {
  return kind !== "argocdapplication" && kind !== "helmrelease";
}
