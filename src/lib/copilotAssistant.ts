import type { CopilotRouteContext } from "./copilotContext";
import { classifyCopilotIntent, type CopilotIntent } from "./copilotIntent";
import {
  collectCopilotEvidence,
  type CopilotEvidenceBundle,
  type CopilotEvidenceClient,
} from "./copilotEvidence";
import {
  buildArgocdAppCta,
  buildEventsCta,
  buildLogsTargetCta,
  type CopilotCta,
} from "./copilotNavigation";
import {
  resolveCopilotResource,
  type CopilotResolvedResource,
  type CopilotResolverClient,
} from "./copilotResourceResolver";

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

export type CopilotResponseMode =
  | "resolved"
  | "ambiguous"
  | "not_found"
  | "handoff"
  | "route";

export type NativeCopilotResponse = CopilotResponse & {
  mode: CopilotResponseMode;
  target?: CopilotResolvedResource;
  candidates?: CopilotResolvedResource[];
  evidence?: CopilotEvidenceBundle;
};

export type NativeCopilotDependencies = {
  intent?: (input: CopilotResponseInput) => CopilotIntent | Promise<CopilotIntent>;
  resolver?: CopilotResolverClient;
  evidence?: CopilotEvidenceClient;
};

export async function buildNativeCopilotResponse(
  input: CopilotResponseInput,
  dependencies: NativeCopilotDependencies = {},
): Promise<NativeCopilotResponse> {
  const intent = dependencies.intent
    ? await dependencies.intent(input)
    : classifyCopilotIntent(input.prompt);
  if (intent.kind === "argocd-app" || intent.kind === "incident-update") {
    return { ...buildCopilotResponse(input, intent), mode: "route" };
  }

  const query = intent.targetText || input.route.resource || input.prompt;
  const resolved = await resolveCopilotResource(
    {
      context: input.clusterContext,
      query,
      namespace: input.route.namespace || undefined,
      intent: intent.kind,
    },
    dependencies.resolver,
  );

  if (resolved.status === "ambiguous") {
    return {
      mode: "ambiguous",
      title: "Choose a matching resource",
      summary: `I found ${resolved.candidates.length} possible matches for ${resolved.query}.`,
      details: resolved.candidates.map(
        (candidate) =>
          `${candidate.kind}/${candidate.namespace}/${candidate.name} (${candidate.score})`,
      ),
      commands: [],
      ctas: [],
      candidates: resolved.candidates,
    };
  }

  if (!resolved.selected) {
    return {
      mode: "not_found",
      title: "No matching resource found",
      summary: `I searched ${resolved.searchedKinds.join(", ")} for ${resolved.query}, but did not find a confident match.`,
      details: [
        `Normalized query: ${resolved.normalizedQuery || "empty"}.`,
        "Try a namespace, exact workload name, or open Workloads search.",
      ],
      commands: [],
      ctas: buildCopilotResponse(input, intent).ctas,
      candidates: [],
    };
  }

  const evidence = await collectCopilotEvidence(
    input.clusterContext,
    resolved.selected,
    dependencies.evidence,
  );
  const mutation = intent.kind === "mutation-request";

  return {
    mode: mutation ? "handoff" : "resolved",
    title: `Found ${resolved.selected.kind}/${resolved.selected.name}`,
    summary: mutation
      ? `Copilot is read-only and cannot ${firstWord(input.prompt)} ${resolved.selected.name}. Review the target and use the existing guarded workflow for any change.`
      : summarizeEvidence(resolved.selected, evidence),
    details: [
      ...resolved.selected.reasons,
      ...evidence.facts.map((fact) => `${fact.label}: ${fact.value}`),
    ],
    commands: readOnlyCommands(input.clusterContext, resolved.selected),
    ctas: evidence.ctas,
    target: resolved.selected,
    evidence,
  };
}

export function buildCopilotResponse(
  input: CopilotResponseInput,
  intent: CopilotIntent = classifyCopilotIntent(input.prompt),
): CopilotResponse {
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

function summarizeEvidence(
  target: CopilotResolvedResource,
  evidence: CopilotEvidenceBundle,
): string {
  const warningText = evidence.warnings
    .slice(0, 2)
    .map((warning) => `${warning.label}: ${warning.detail ?? warning.value}`)
    .join("; ");
  const health = `I resolved ${target.displayName}. Health is ${evidence.health}.`;
  return warningText ? `${health} ${warningText}.` : health;
}

function readOnlyCommands(
  context: string,
  target: CopilotResolvedResource,
): string[] {
  return [
    `kubectl get ${target.kind} -n ${target.namespace} ${target.name}`,
    `kubectl get events -n ${target.namespace} --field-selector involvedObject.name=${target.name}`,
    `# context: ${context}`,
  ];
}

function firstWord(value: string): string {
  return value.trim().split(/\s+/)[0]?.toLowerCase() || "change";
}
