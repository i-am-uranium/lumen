import type { CopilotRouteContext } from "./copilotContext";
import { classifyCopilotIntent } from "./copilotIntent";
import {
  buildArgocdAppCta,
  buildEventsCta,
  buildLogsTargetCta,
  type CopilotCta,
} from "./copilotNavigation";

export type CopilotResponse = {
  title: string;
  summary: string;
  details: string[];
  commands: string[];
  ctas: CopilotCta[];
};

export type CopilotResponseInput = {
  prompt: string;
  clusterContext: string;
  route: CopilotRouteContext;
};

export function buildCopilotResponse(input: CopilotResponseInput): CopilotResponse {
  const intent = classifyCopilotIntent(input.prompt);
  const namespace = input.route.namespace || undefined;

  if (intent.kind === "logs") {
    const search = intent.targetText || input.prompt;
    const targetLabel = intent.targetText || "this service";
    const slug = slugifyName(search);
    const commands = namespace
      ? [`kubectl logs -n ${namespace} deployment/${slug} --tail=200 --since=30m`]
      : [
          `kubectl get pods -A | grep -i ${shellToken(search)}`,
          `kubectl logs -A -l app=${slug} --tail=200 --since=30m`,
        ];

    return {
      title: `Open logs for ${targetLabel}`,
      summary:
        "I found a read-only logs path. Open the logs view with the query prefilled, then choose the exact pod/container if there are multiple matches.",
      details: [
        namespace
          ? `Scope: namespace ${namespace}.`
          : "Scope: all namespaces until a specific namespace is selected.",
        "No cluster action is executed from the copilot drawer.",
      ],
      commands,
      ctas: [
        {
          ...buildLogsTargetCta(
            input.clusterContext,
            { kind: "deployment", namespace, name: slug },
            search,
          ),
          label: "Open logs",
        },
      ],
    };
  }

  if (intent.kind === "argocd-app") {
    const targetLabel = intent.targetText || input.route.resource || "application";
    const appName = slugifyName(targetLabel);
    const cta = buildArgocdAppCta(input.clusterContext, {
      kind: "application",
      namespace: "argocd",
      name: appName,
    });

    return {
      title: `Review ${targetLabel} in ArgoCD`,
      summary:
        "I will not run sync from here. Open the ArgoCD application, review drift and sync preview, then run the action from that page if it is still correct.",
      details: [
        "This first Copilot iteration is read-only.",
        "The CTA preserves operator control for sync and rollback actions.",
      ],
      commands: [
        `kubectl get applications.argoproj.io -A | grep -i ${shellToken(appName)}`,
      ],
      ctas: [{ ...cta, label: "Open ArgoCD app" }],
    };
  }

  if (intent.kind === "incident-update") {
    return {
      title: "Prepare an incident update",
      summary:
        "Use the triage workspace to collect alerts, related events, and impacted resources before drafting an update.",
      details: [
        "I can summarize the current page context and keep the investigation session open while you navigate.",
      ],
      commands: [
        namespace
          ? `kubectl get events -n ${namespace} --sort-by=.lastTimestamp`
          : "kubectl get events -A --sort-by=.lastTimestamp",
      ],
      ctas: [
        {
          id: "open-incident-triage",
          label: "Open incident triage",
          description: "Review grouped health signals and evidence.",
          to: `/cluster/${encodeURIComponent(input.clusterContext)}/triage`,
          intent: "search",
          icon: "siren",
          readOnly: true,
        },
        buildEventsCta(input.clusterContext, namespace),
      ],
    };
  }

  return {
    title: "Start a read-only investigation",
    summary:
      "I can keep this as a persisted investigation and route you to the right workspace. Use the full AI assistant page when you want model-backed analysis over redacted context.",
    details: [
      `Current page: ${input.route.page}.`,
      "This drawer only suggests read-only checks and navigation CTAs.",
    ],
    commands: [
      namespace
        ? `kubectl get events -n ${namespace} --sort-by=.lastTimestamp`
        : "kubectl get events -A --sort-by=.lastTimestamp",
    ],
    ctas: [
      {
        id: "open-full-ai-assistant",
        label: "Open AI assistant",
        description: "Continue with model-backed analysis on the full page.",
        to: `/cluster/${encodeURIComponent(input.clusterContext)}/ai?question=${encodeURIComponent(input.prompt)}`,
        intent: "search",
        icon: "sparkles",
        readOnly: true,
      },
      buildEventsCta(input.clusterContext, namespace, intent.targetText ?? undefined),
    ],
  };
}

function slugifyName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shellToken(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "app";
}
