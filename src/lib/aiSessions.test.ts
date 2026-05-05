import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_SESSIONS_LIMIT,
  AI_SESSIONS_STORAGE_KEY,
  type AiAssistantSession,
  deleteAiSession,
  listAiSessions,
  loadAiSessions,
  saveAiSession,
} from "./aiSessions";

function makeSession(id: string, updatedAt: string): AiAssistantSession {
  return {
    id,
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt,
    title: `Session ${id}`,
    task: "Inspect pods",
    question: "Why is the deployment unhealthy?",
    notes: "Needs follow-up",
    provider: "codex",
    model: "gpt-5",
    prompt: "Summarize the cluster state",
    context: [{ label: "Namespace", value: "default", summary: "Default namespace" }],
    redactions: { findings: [{ label: "tokens", count: 2 }], count: 2 },
    result: {
      stdout: "Looks healthy",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      completedAt: "2026-05-04T00:01:00.000Z",
    },
    commandRuns: [
      {
        command: "kubectl get pods",
        stdout: "pod/app Running",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        durationMs: 42,
        startedAt: "2026-05-04T00:00:30.000Z",
      },
    ],
  };
}

describe("aiSessions", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads an empty list when storage is empty", () => {
    expect(loadAiSessions()).toEqual([]);
    expect(listAiSessions()).toEqual([]);
  });

  it("returns an empty list for malformed JSON", () => {
    window.localStorage.setItem(AI_SESSIONS_STORAGE_KEY, "{not-json");

    expect(loadAiSessions()).toEqual([]);
  });

  it("saves sessions in most recently updated order and caps stored entries", () => {
    for (let index = 0; index < AI_SESSIONS_LIMIT + 3; index += 1) {
      saveAiSession(makeSession(`session-${index}`, `2026-05-04T00:${String(index).padStart(2, "0")}:00.000Z`));
    }

    const sessions = listAiSessions();
    expect(sessions).toHaveLength(AI_SESSIONS_LIMIT);
    expect(sessions[0]?.id).toBe(`session-${AI_SESSIONS_LIMIT + 2}`);
    expect(sessions[sessions.length - 1]?.id).toBe("session-3");

    const raw = window.localStorage.getItem(AI_SESSIONS_STORAGE_KEY);
    expect(JSON.parse(raw ?? "[]")).toHaveLength(AI_SESSIONS_LIMIT);
  });

  it("updates an existing session instead of duplicating it", () => {
    saveAiSession(makeSession("same", "2026-05-04T00:00:00.000Z"));
    saveAiSession({
      ...makeSession("same", "2026-05-04T00:05:00.000Z"),
      title: "Updated title",
      notes: "Updated notes",
    });

    expect(listAiSessions()).toMatchObject([
      {
        id: "same",
        title: "Updated title",
        notes: "Updated notes",
      },
    ]);
  });

  it("deletes a session", () => {
    saveAiSession(makeSession("keep", "2026-05-04T00:01:00.000Z"));
    saveAiSession(makeSession("delete", "2026-05-04T00:02:00.000Z"));

    expect(deleteAiSession("delete").map((session) => session.id)).toEqual(["keep"]);
    expect(listAiSessions().map((session) => session.id)).toEqual(["keep"]);
  });

  it("tolerates legacy entries with unknown fields", () => {
    window.localStorage.setItem(
      AI_SESSIONS_STORAGE_KEY,
      JSON.stringify({
        sessions: [
          {
            id: "legacy",
            createdAt: "2026-05-04T00:00:00.000Z",
            updatedAt: "2026-05-04T00:00:01.000Z",
            title: "Legacy",
            extra: { old: true },
            redactions: { findings: [{ label: "tokens", count: 1 }] },
          },
        ],
      }),
    );

    expect(loadAiSessions()).toMatchObject([
      {
        id: "legacy",
        title: "Legacy",
        task: "",
        redactions: { count: 1 },
        commandRuns: [],
      },
    ]);
  });

  it("normalizes invalid exit codes to unknown instead of success", () => {
    window.localStorage.setItem(
      AI_SESSIONS_STORAGE_KEY,
      JSON.stringify([
        {
          id: "invalid-exit",
          updatedAt: "2026-05-04T00:00:01.000Z",
          result: { stdout: "", stderr: "", exitCode: "0", timedOut: false },
          commandRuns: [
            {
              command: "kubectl get pods",
              exitCode: "0",
              stdout: "",
              stderr: "",
            },
          ],
        },
      ]),
    );

    const [session] = loadAiSessions();
    expect(session?.result?.exitCode).toBeNull();
    expect(session?.commandRuns[0]?.exitCode).toBeNull();
  });

  it("tolerates missing window", () => {
    vi.stubGlobal("window", undefined);

    expect(loadAiSessions()).toEqual([]);
    expect(deleteAiSession("missing")).toEqual([]);
    expect(() => saveAiSession(makeSession("no-window", "2026-05-04T00:00:00.000Z"))).not.toThrow();
  });
});
