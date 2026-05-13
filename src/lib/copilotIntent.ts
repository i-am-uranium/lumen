export type CopilotIntentKind =
  | "logs"
  | "argocd-app"
  | "incident-update"
  | "mutation-request"
  | "investigate";

export type CopilotRequestedAction = "sync" | "open" | "mutate" | "none";

export type CopilotIntent = {
  kind: CopilotIntentKind;
  targetText: string;
  requestedAction: CopilotRequestedAction;
  prompt: string;
};

const LOG_PATTERNS = [
  /\b(?:show|open|get|fetch|tail|find)\s+(?:me\s+)?(?:the\s+)?(?:latest|recent)?\s*logs?\s+(?:for|from|of)\s+(.+)$/i,
  /\b(?:show|open|get|fetch|tail|find)\s+(?:me\s+)?(?:the\s+)?(?:latest|recent)?\s*(.+?)\s+logs?\b/i,
  /\blogs?\s+(?:for|from|of)\s+(.+)$/i,
];

const ARGO_SYNC_PATTERNS = [
  /\b(?:deployed|deploying|released|release)\s+(?:the\s+)?(.+?)(?:,|\s+and)?\s+(?:please\s+)?(?:sync|open\s+sync)\b/i,
  /\b(?:sync|open)\s+(?:the\s+)?(.+?)(?:\s+(?:app|application))?$/i,
];

const MUTATION_PATTERNS = [
  /\b(?:restart|delete|scale|rollback|sync|apply|upgrade|uninstall)\s+(?:the\s+)?(.+)$/i,
];

const INVESTIGATION_PATTERNS = [
  /\bwhy\s+is\s+(?:the\s+)?(.+?)\s+(?:failing|broken|unhealthy|crashing|restarting|down)\b/i,
  /\binvestigate\s+(?:the\s+)?(.+)$/i,
  /\bexplain\s+(?:the\s+)?(.+)$/i,
];

export function classifyCopilotIntent(prompt: string): CopilotIntent {
  const normalized = normalizePrompt(prompt);
  const lower = normalized.toLowerCase();

  for (const pattern of LOG_PATTERNS) {
    const targetText = extractTarget(normalized, pattern);
    if (targetText) {
      return { kind: "logs", targetText, requestedAction: "open", prompt };
    }
  }

  if (/\b(?:sync|argocd|argo cd|deployed|released)\b/i.test(normalized)) {
    for (const pattern of ARGO_SYNC_PATTERNS) {
      const targetText = extractTarget(normalized, pattern);
      if (targetText) {
        return {
          kind: "argocd-app",
          targetText,
          requestedAction: lower.includes("sync") ? "sync" : "open",
          prompt,
        };
      }
    }
  }

  for (const pattern of MUTATION_PATTERNS) {
    const targetText = extractTarget(normalized, pattern);
    if (targetText) {
      return {
        kind: "mutation-request",
        targetText,
        requestedAction: "mutate",
        prompt,
      };
    }
  }

  if (/\b(?:incident|update|handoff|status)\b/i.test(normalized)) {
    return {
      kind: "incident-update",
      targetText: "",
      requestedAction: "none",
      prompt,
    };
  }

  for (const pattern of INVESTIGATION_PATTERNS) {
    const targetText = extractTarget(normalized, pattern);
    if (targetText && !/^(?:this|that|it)$/i.test(targetText)) {
      return {
        kind: "investigate",
        targetText,
        requestedAction: "none",
        prompt,
      };
    }
  }

  return {
    kind: "investigate",
    targetText: "",
    requestedAction: "none",
    prompt,
  };
}

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function extractTarget(prompt: string, pattern: RegExp): string {
  const raw = prompt.match(pattern)?.[1] ?? "";
  return raw
    .replace(/\b(?:please|sync|open|app|application)\b/gi, " ")
    .replace(/[,.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
