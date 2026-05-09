export type CopilotIntentKind =
  | "logs"
  | "argocd-app"
  | "incident-update"
  | "investigate";

export type CopilotRequestedAction = "sync" | "open" | "none";

export type CopilotIntent = {
  kind: CopilotIntentKind;
  targetText: string;
  requestedAction: CopilotRequestedAction;
  prompt: string;
};

const LOG_PATTERNS = [
  /\b(?:show|open|get|tail|find)\s+(?:the\s+)?(?:latest|recent)?\s*logs?\s+(?:for|from|of)\s+(.+)$/i,
  /\blogs?\s+(?:for|from|of)\s+(.+)$/i,
];

const ARGO_SYNC_PATTERNS = [
  /\b(?:deployed|deploying|released|release)\s+(?:the\s+)?(.+?)(?:,|\s+and)?\s+(?:please\s+)?(?:sync|open\s+sync)\b/i,
  /\b(?:sync|open)\s+(?:the\s+)?(.+?)(?:\s+(?:app|application))?$/i,
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

  if (/\b(?:incident|update|handoff|status)\b/i.test(normalized)) {
    return {
      kind: "incident-update",
      targetText: "",
      requestedAction: "none",
      prompt,
    };
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
