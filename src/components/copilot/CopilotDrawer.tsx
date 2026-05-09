import { FormEvent, useMemo, useState } from "react";
import { Bot, ClipboardList, LockKeyhole, Plus, SendHorizontal, X } from "lucide-react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DrawerBackdrop,
  DrawerHeader,
  DrawerPanel,
} from "@/components/lumen/drawer";
import {
  buildCopilotResponse,
  buildNativeCopilotResponse,
  type CopilotResponse,
  type NativeCopilotResponse,
} from "@/lib/copilotAssistant";
import {
  buildCopilotPromptContext,
  buildCopilotRouteContext,
} from "@/lib/copilotContext";
import {
  createSessionId,
  listAiSessions,
  saveAiSession,
  type AiAssistantSession,
} from "@/lib/aiSessions";
import { useCopilotUi } from "@/state/copilotUi";
import { cn } from "@/lib/utils";
import { CopilotCtaCard } from "./CopilotCtaCard";

type Props = {
  clusterContext: string;
};

export function CopilotDrawer({ clusterContext }: Props) {
  const location = useLocation();
  const isOpen = useCopilotUi((s) => s.isOpen);
  const activeSessionId = useCopilotUi((s) => s.activeSessionId);
  const draft = useCopilotUi((s) => s.draft);
  const closeDrawer = useCopilotUi((s) => s.closeDrawer);
  const setDraft = useCopilotUi((s) => s.setDraft);
  const setActiveSession = useCopilotUi((s) => s.setActiveSession);
  const startNewInvestigation = useCopilotUi((s) => s.startNewInvestigation);
  const [sessionVersion, setSessionVersion] = useState(0);
  const [liveResponse, setLiveResponse] = useState<NativeCopilotResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const route = useMemo(
    () => buildCopilotRouteContext(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const activeSession = useMemo(
    () => listAiSessions().find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessionVersion],
  );
  const sessionResponse = useMemo(
    () =>
      activeSession
        ? buildCopilotResponse({
            prompt: activeSession.question || activeSession.prompt,
            clusterContext,
            route,
          })
        : null,
    [activeSession, clusterContext, route],
  );
  const response = liveResponse ?? sessionResponse;
  const nativeResponse: NativeCopilotResponse | null =
    response && "mode" in response ? (response as NativeCopilotResponse) : null;

  if (!isOpen) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || running) return;

    setRunning(true);
    setError(null);
    try {
      const nextResponse = await buildNativeCopilotResponse({
        prompt: question,
        clusterContext,
        route,
      });
      const session = createCopilotSession({
        clusterContext,
        question,
        route,
        response: nextResponse,
      });
      saveAiSession(session);
      setLiveResponse(nextResponse);
      setActiveSession(session.id);
      setSessionVersion((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  }

  function newInvestigation() {
    setLiveResponse(null);
    setError(null);
    startNewInvestigation();
  }

  const title = response?.title ?? activeSession?.title ?? "Ask about this cluster";

  return (
    <>
      <DrawerBackdrop className="bg-black/15" onClick={closeDrawer} />
      <DrawerPanel
        width={420}
        role="complementary"
        aria-label="Operator Copilot"
        className="z-50 bg-surface"
      >
        <DrawerHeader className="justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-control border border-border-default bg-elevated text-accent-primary">
              <Bot className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-semibold text-text-primary">
                Operator Copilot
              </div>
              <div className="flex items-center gap-1 text-[11px] text-text-secondary">
                <LockKeyhole className="size-3" aria-hidden="true" />
                read-only
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={newInvestigation}
              aria-label="new investigation"
              title="new investigation"
            >
              <Plus className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={closeDrawer}
              aria-label="close Copilot"
              title="close Copilot"
            >
              <X className="size-4" />
            </Button>
          </div>
        </DrawerHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <section className="rounded-control border border-border-default bg-elevated p-3">
              <div className="flex items-start gap-2">
                <ClipboardList className="mt-0.5 size-4 shrink-0 text-accent-primary" aria-hidden="true" />
                <div className="min-w-0">
                  <h2 className="text-[13px] font-semibold text-text-primary">{title}</h2>
                  <p className="mt-1 text-[12px] leading-5 text-text-secondary">
                    {response?.summary ??
                      "Ask for logs, events, rollout context, incident updates, or where to continue a task. Copilot will keep navigation explicit and avoid mutating cluster state."}
                  </p>
                </div>
              </div>
            </section>

            {response && (
              <section className="space-y-3" aria-label="Copilot response">
                {nativeResponse?.target && (
                  <div className="space-y-2">
                    <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                      target
                    </h3>
                    <div className="rounded-control border border-border-default bg-elevated px-3 py-2">
                      <div className="text-[12px] font-medium text-text-primary">
                        {nativeResponse.target.displayName}
                      </div>
                      <div className="mt-1 text-[11px] text-text-muted">
                        {nativeResponse.target.source} / score {nativeResponse.target.score}
                      </div>
                    </div>
                  </div>
                )}

                {nativeResponse?.candidates && nativeResponse.candidates.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                      candidates
                    </h3>
                    <div className="space-y-2">
                      {nativeResponse.candidates.map((candidate) => (
                        <div
                          key={candidate.id}
                          className="rounded-control border border-border-default bg-elevated px-3 py-2 text-[12px] text-text-primary"
                        >
                          {candidate.displayName} ({candidate.score})
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {response.ctas.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                      next step
                    </h3>
                    {response.ctas.map((cta) => (
                      <CopilotCtaCard key={cta.id} cta={cta} onNavigate={closeDrawer} />
                    ))}
                  </div>
                )}

                {response.details.length > 0 && nativeResponse?.mode !== "ambiguous" && (
                  <div className="space-y-2">
                    <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                      notes
                    </h3>
                    <ul className="space-y-1.5 text-[12px] leading-5 text-text-secondary">
                      {response.details.map((detail) => (
                        <li
                          key={detail}
                          className="rounded-control border border-border-default bg-elevated px-3 py-2"
                        >
                          {detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {nativeResponse?.evidence && (
                  <div className="space-y-2">
                    <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                      evidence
                    </h3>
                    <div className="space-y-2">
                      {[
                        ...nativeResponse.evidence.facts,
                        ...nativeResponse.evidence.warnings,
                      ].map((fact) => (
                        <div
                          key={fact.id}
                          className="rounded-control border border-border-default bg-elevated px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-[12px] font-medium text-text-primary">
                              {fact.label}
                            </span>
                            <span className="text-right text-[12px] text-text-secondary">
                              {fact.value}
                            </span>
                          </div>
                          {fact.detail && (
                            <p className="mt-1 text-[11px] leading-4 text-text-muted">
                              {fact.detail}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {response.commands.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                      safe checks
                    </h3>
                    <div className="space-y-2">
                      {response.commands.map((command) => (
                        <code
                          key={command}
                          className={cn(
                            "block overflow-x-auto rounded-control border border-border-default bg-[var(--terminal-bg)] px-3 py-2",
                            "font-mono text-[11px] leading-5 text-[var(--terminal-fg)]",
                          )}
                        >
                          {command}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>

          <form onSubmit={submit} className="shrink-0 border-t border-border-default bg-shell p-3">
            <label className="block text-[11px] font-medium uppercase tracking-wide text-text-muted">
              Ask Copilot
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                className="mt-2 w-full resize-none rounded-control border border-border-default bg-elevated px-3 py-2 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-primary/45"
                placeholder="show latest logs from customer service"
              />
            </label>
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className={cn("text-[11px]", error ? "text-danger" : "text-text-muted")}>
                {error ?? "CTAs navigate; actions stay on their owning pages."}
              </p>
              <Button type="submit" size="sm" disabled={!draft.trim() || running} aria-label="send">
                <SendHorizontal className="size-3.5" />
                {running ? "Thinking" : "Send"}
              </Button>
            </div>
          </form>
        </div>
      </DrawerPanel>
    </>
  );
}

function createCopilotSession({
  clusterContext,
  question,
  route,
  response,
}: {
  clusterContext: string;
  question: string;
  route: ReturnType<typeof buildCopilotRouteContext>;
  response: CopilotResponse;
}): AiAssistantSession {
  const now = new Date().toISOString();
  return {
    id: createSessionId(),
    createdAt: now,
    updatedAt: now,
    title: response.title,
    task: "operator-copilot",
    question,
    notes: "",
    provider: "lumen-copilot",
    model: "read-only-router",
    prompt: buildCopilotPromptContext({ clusterContext, route, prompt: question }),
    context: [
      { label: "Cluster", value: clusterContext },
      { label: "Page", value: route.page },
      ...(route.namespace ? [{ label: "Namespace", value: route.namespace }] : []),
      ...(route.resource ? [{ label: "Resource", value: route.resource }] : []),
    ],
    redactions: { findings: [], count: 0 },
    result: {
      stdout: renderCopilotStdout(response),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      completedAt: now,
    },
    commandRuns: [],
  };
}

function renderCopilotStdout(response: CopilotResponse): string {
  return [
    `Summary\n${response.summary}`,
    response.details.length ? `Next checks\n${response.details.join("\n")}` : "",
    response.commands.length
      ? `Safe kubectl commands\n${response.commands.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
