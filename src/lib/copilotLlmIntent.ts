import { ai, type AiRunResult } from "@/lib/ai";
import type { CopilotRouteContext } from "./copilotContext";
import {
  classifyCopilotIntent,
  type CopilotIntent,
  type CopilotIntentKind,
  type CopilotRequestedAction,
} from "./copilotIntent";
import type { AiProviderId } from "./aiSettings";

type ModelIntentInput = {
  prompt: string;
  clusterContext: string;
  route: CopilotRouteContext;
  provider: AiProviderId;
  model: string;
  instructions: string;
};

type ModelIntentClient = {
  runPrompt: (provider: string, prompt: string, model?: string) => Promise<AiRunResult>;
};

const INTENT_KINDS = new Set<CopilotIntentKind>([
  "logs",
  "argocd-app",
  "incident-update",
  "mutation-request",
  "investigate",
]);

const REQUESTED_ACTIONS = new Set<CopilotRequestedAction>([
  "sync",
  "open",
  "mutate",
  "none",
]);

export async function classifyCopilotIntentWithModel(
  input: ModelIntentInput,
  client: ModelIntentClient = ai,
): Promise<CopilotIntent> {
  try {
    const result = await client.runPrompt(
      input.provider,
      buildIntentPrompt(input),
      input.model || undefined,
    );
    if (result.timed_out || result.exit_code !== 0) {
      return classifyCopilotIntent(input.prompt);
    }
    return parseModelIntent(result.stdout, input.prompt) ?? classifyCopilotIntent(input.prompt);
  } catch {
    return classifyCopilotIntent(input.prompt);
  }
}

function buildIntentPrompt(input: ModelIntentInput): string {
  return [
    input.instructions.trim(),
    "",
    "Classify this Lumen Operator Copilot request. The Copilot is read-only and should route the operator to the right workspace or evidence.",
    "",
    "Return only compact JSON with this exact shape:",
    '{"kind":"logs|argocd-app|incident-update|mutation-request|investigate","targetText":"string","requestedAction":"sync|open|mutate|none"}',
    "",
    "Meaning:",
    "- logs: user wants recent logs or to tail logs for a workload/service/pod.",
    "- argocd-app: user wants an ArgoCD app reviewed/opened/synced after deploy.",
    "- incident-update: user asks for status, handoff, or incident update.",
    "- mutation-request: user asks to restart, delete, scale, apply, rollback, upgrade, uninstall, or perform any change.",
    "- investigate: user asks why something is failing or needs general diagnosis.",
    "",
    "Examples:",
    'User: "fetch me the latest logs of oaut-service"',
    '{"kind":"logs","targetText":"oaut-service","requestedAction":"open"}',
    'User: "I deployed the doctor dashboard, please sync"',
    '{"kind":"argocd-app","targetText":"doctor dashboard","requestedAction":"sync"}',
    'User: "restart customer service"',
    '{"kind":"mutation-request","targetText":"customer service","requestedAction":"mutate"}',
    "",
    `Cluster: ${input.clusterContext}`,
    `Current page: ${input.route.page}`,
    `Namespace: ${input.route.namespace || "all"}`,
    `Focused resource: ${input.route.resource || "none"}`,
    "",
    `User: ${input.prompt}`,
  ].join("\n");
}

function parseModelIntent(stdout: string, prompt: string): CopilotIntent | null {
  const json = extractJsonObject(stdout);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json) as Partial<CopilotIntent>;
    const kind = parsed.kind;
    const requestedAction = parsed.requestedAction;
    if (!kind || !INTENT_KINDS.has(kind)) return null;
    if (!requestedAction || !REQUESTED_ACTIONS.has(requestedAction)) return null;

    return {
      kind,
      targetText: typeof parsed.targetText === "string" ? parsed.targetText.trim() : "",
      requestedAction,
      prompt,
    };
  } catch {
    return null;
  }
}

function extractJsonObject(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced?.startsWith("{") && fenced.endsWith("}")) return fenced;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : null;
}
