export const AI_SETTINGS_STORAGE_KEY = "lumen:ai-assistant:settings";

export type AiProviderId = "codex" | "claude";

export type AiAssistantSettings = {
  provider: AiProviderId;
  model: string;
  detailsOpen: boolean;
  includeHealth: boolean;
  includeMetrics: boolean;
  includeNotes: boolean;
  copilotModelIntent: boolean;
  copilotInstructions: string;
};

export const DEFAULT_COPILOT_INSTRUCTIONS =
  "You are a Kubernetes operator assistant inside Lumen. Understand the user's intent, preserve exact workload names, prefer read-only navigation, and never invent destructive actions.";

const DEFAULT_AI_SETTINGS: AiAssistantSettings = {
  provider: "codex",
  model: "",
  detailsOpen: false,
  includeHealth: true,
  includeMetrics: true,
  includeNotes: true,
  copilotModelIntent: true,
  copilotInstructions: DEFAULT_COPILOT_INSTRUCTIONS,
};

export function readAiAssistantSettings(): AiAssistantSettings {
  if (typeof window === "undefined") {
    return DEFAULT_AI_SETTINGS;
  }
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(AI_SETTINGS_STORAGE_KEY) ?? "{}",
    ) as Partial<AiAssistantSettings>;
    return normalizeAiAssistantSettings(parsed);
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
}

export function writeAiAssistantSettings(settings: AiAssistantSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      AI_SETTINGS_STORAGE_KEY,
      JSON.stringify(normalizeAiAssistantSettings(settings)),
    );
  } catch {
    // Local persistence is best-effort; the assistant remains usable without it.
  }
}

export function normalizeAiAssistantSettings(
  settings: Partial<AiAssistantSettings>,
): AiAssistantSettings {
  return {
    provider: settings.provider === "claude" ? "claude" : "codex",
    model: typeof settings.model === "string" ? settings.model : DEFAULT_AI_SETTINGS.model,
    detailsOpen: settings.detailsOpen === true,
    includeHealth: settings.includeHealth !== false,
    includeMetrics: settings.includeMetrics !== false,
    includeNotes: settings.includeNotes !== false,
    copilotModelIntent: settings.copilotModelIntent !== false,
    copilotInstructions:
      typeof settings.copilotInstructions === "string" &&
      settings.copilotInstructions.trim()
        ? settings.copilotInstructions
        : DEFAULT_COPILOT_INSTRUCTIONS,
  };
}
