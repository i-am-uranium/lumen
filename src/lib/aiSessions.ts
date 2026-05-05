import type { RedactionFinding } from "./aiRedaction";

export const AI_SESSIONS_STORAGE_KEY = "lumen:ai:sessions";
export const AI_SESSIONS_LIMIT = 25;

export type AiSessionContextItem = {
  label: string;
  value?: string;
  summary?: string;
};

export type AiSessionRedactionSummary = {
  findings: RedactionFinding[];
  count: number;
};

export type AiSessionResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  completedAt?: string;
};

export type AiSessionCommandRun = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
};

export type AiAssistantSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  task: string;
  question: string;
  notes: string;
  provider: string;
  model: string;
  prompt: string;
  context: AiSessionContextItem[];
  redactions: AiSessionRedactionSummary;
  result?: AiSessionResult;
  commandRuns: AiSessionCommandRun[];
};

type StoredSessions = AiAssistantSession[] | { sessions?: unknown };
type SessionCrypto = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

let sessionIdCounter = 0;

export function createSessionId(): string {
  const webCrypto = (
    typeof globalThis !== "undefined" && "crypto" in globalThis
      ? globalThis.crypto
      : undefined
  ) as SessionCrypto | undefined;
  const random =
    webCrypto?.randomUUID?.() ??
    (() => {
      if (webCrypto?.getRandomValues) {
        const bytes = new Uint8Array(10);
        webCrypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      }
      sessionIdCounter += 1;
      return `fallback_${sessionIdCounter.toString(36)}`;
    })();
  return `ai_${Date.now().toString(36)}_${random}`;
}

export function loadAiSessions(): AiAssistantSession[] {
  const storage = getStorage();
  if (!storage) {
    return [];
  }

  try {
    return normalizeStoredSessions(JSON.parse(storage.getItem(AI_SESSIONS_STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function listAiSessions(): AiAssistantSession[] {
  return loadAiSessions();
}

export function saveAiSession(session: AiAssistantSession): AiAssistantSession[] {
  const nextSession = sanitizeSession(session);
  if (!nextSession) {
    return loadAiSessions();
  }

  const sessions = [nextSession, ...loadAiSessions().filter((item) => item.id !== nextSession.id)];
  const next = capSessions(sortSessions(sessions));
  writeSessions(next);
  return next;
}

export function deleteAiSession(id: string): AiAssistantSession[] {
  const next = loadAiSessions().filter((session) => session.id !== id);
  writeSessions(next);
  return next;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function writeSessions(sessions: AiAssistantSession[]): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(AI_SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    // Persistence is best-effort; callers still receive the in-memory result.
  }
}

function normalizeStoredSessions(value: unknown): AiAssistantSession[] {
  const stored = value as StoredSessions;
  const items = Array.isArray(stored) ? stored : Array.isArray(stored?.sessions) ? stored.sessions : [];
  return capSessions(sortSessions(items.map(sanitizeSession).filter((item) => item !== null)));
}

function sanitizeSession(value: unknown): AiAssistantSession | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = asString(value.id);
  if (!id) {
    return null;
  }

  return {
    id,
    createdAt: asString(value.createdAt) || asString(value.updatedAt) || new Date(0).toISOString(),
    updatedAt: asString(value.updatedAt) || asString(value.createdAt) || new Date(0).toISOString(),
    title: asString(value.title) || "Untitled AI run",
    task: asString(value.task),
    question: asString(value.question),
    notes: asString(value.notes),
    provider: asString(value.provider),
    model: asString(value.model),
    prompt: asString(value.prompt),
    context: asContextItems(value.context),
    redactions: asRedactions(value.redactions),
    result: asResult(value.result),
    commandRuns: asCommandRuns(value.commandRuns),
  };
}

function asContextItems(value: unknown): AiSessionContextItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const label = asString(item.label);
    if (!label) {
      return [];
    }

    return [
      {
        label,
        value: optionalString(item.value),
        summary: optionalString(item.summary),
      },
    ];
  });
}

function asRedactions(value: unknown): AiSessionRedactionSummary {
  if (!isRecord(value)) {
    return { findings: [], count: 0 };
  }

  const findings = Array.isArray(value.findings)
    ? value.findings.flatMap((finding) => {
        if (!isRecord(finding)) {
          return [];
        }

        const label = asString(finding.label);
        const count = asFiniteNumber(finding.count);
        if (!label || count <= 0) {
          return [];
        }

        return [{ label, count }];
      })
    : [];

  return {
    findings,
    count: Math.max(0, asFiniteNumber(value.count) || findings.reduce((sum, finding) => sum + finding.count, 0)),
  };
}

function asResult(value: unknown): AiSessionResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    stdout: asString(value.stdout),
    stderr: asString(value.stderr),
    exitCode: asNullableNumber(value.exitCode),
    timedOut: Boolean(value.timedOut),
    completedAt: optionalString(value.completedAt),
  };
}

function asCommandRuns(value: unknown): AiSessionCommandRun[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((run) => {
    if (!isRecord(run)) {
      return [];
    }

    const command = asString(run.command);
    if (!command) {
      return [];
    }

    return [
      {
        command,
        stdout: asString(run.stdout),
        stderr: asString(run.stderr),
        exitCode: asNullableNumber(run.exitCode),
        timedOut: Boolean(run.timedOut),
        durationMs: Math.max(0, asFiniteNumber(run.durationMs)),
        startedAt: asString(run.startedAt),
      },
    ];
  });
}

function sortSessions(sessions: AiAssistantSession[]): AiAssistantSession[] {
  return [...sessions].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
}

function capSessions(sessions: AiAssistantSession[]): AiAssistantSession[] {
  return sessions.slice(0, AI_SESSIONS_LIMIT);
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
