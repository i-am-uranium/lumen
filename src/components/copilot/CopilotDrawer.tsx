import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  useMessage,
  type ChatModelAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";
import {
  Bot,
  LockKeyhole,
  Plus,
  SendHorizontal,
  Settings2,
  X,
} from "lucide-react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ai } from "@/lib/ai";
import {
  DEFAULT_COPILOT_INSTRUCTIONS,
  readAiAssistantSettings,
  writeAiAssistantSettings,
  type AiAssistantSettings,
  type AiProviderId,
} from "@/lib/aiSettings";
import {
  DrawerBackdrop,
  DrawerHeader,
  DrawerPanel,
} from "@/components/lumen/drawer";
import {
  buildNativeCopilotResponse,
  type CopilotResponse,
  type NativeCopilotResponse,
} from "@/lib/copilotAssistant";
import {
  buildCopilotPromptContext,
  buildCopilotRouteContext,
} from "@/lib/copilotContext";
import { classifyCopilotIntentWithModel } from "@/lib/copilotLlmIntent";
import {
  createSessionId,
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
  const draft = useCopilotUi((s) => s.draft);
  const closeDrawer = useCopilotUi((s) => s.closeDrawer);
  const setDraft = useCopilotUi((s) => s.setDraft);
  const setActiveSession = useCopilotUi((s) => s.setActiveSession);
  const startNewInvestigation = useCopilotUi((s) => s.startNewInvestigation);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiAssistantSettings>(() =>
    readAiAssistantSettings(),
  );

  const providers = useQuery({
    queryKey: ["ai", "providers"],
    queryFn: ai.detectProviders,
    staleTime: 30_000,
  });

  const route = useMemo(
    () => buildCopilotRouteContext(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const selectedProvider = providers.data?.find((provider) => provider.id === aiSettings.provider);
  const selectedModel = selectedProvider?.models.includes(aiSettings.model)
    ? aiSettings.model
    : (selectedProvider?.default_model ?? selectedProvider?.models[0] ?? aiSettings.model);

  const chatModel = useMemo<ChatModelAdapter>(
    () => ({
      run: async ({ messages }) => {
        const question = getLatestUserText(messages).trim();
        if (!question) {
          return {
            content: [{ type: "text", text: "Ask me what to inspect next." }],
            status: { type: "complete", reason: "stop" },
          };
        }

        setError(null);
        try {
          const nextResponse = await buildNativeCopilotResponse(
            {
              prompt: question,
              clusterContext,
              route,
            },
            {
              intent:
                aiSettings.copilotModelIntent && selectedProvider?.available
                  ? (request) =>
                      classifyCopilotIntentWithModel({
                        ...request,
                        provider: aiSettings.provider,
                        model: selectedModel,
                        instructions: aiSettings.copilotInstructions,
                      })
                  : undefined,
            },
          );
          const session = createCopilotSession({
            clusterContext,
            question,
            route,
            response: nextResponse,
          });
          saveAiSession(session);
          setActiveSession(session.id);

          return {
            content: [{ type: "text", text: renderAssistantText(nextResponse) }],
            status: { type: "complete", reason: "stop" },
            metadata: {
              custom: {
                copilotResponse: nextResponse,
              },
            },
          };
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          setError(message);
          return {
            content: [
              {
                type: "text",
                text: `I could not finish that request.\n\n${message}`,
              },
            ],
            status: { type: "incomplete", reason: "error", error: message },
          };
        }
      },
    }),
    [aiSettings, clusterContext, route, selectedModel, selectedProvider, setActiveSession],
  );
  const runtime = useLocalRuntime(chatModel);

  useEffect(() => {
    if (!draft.trim()) return;
    if (runtime.thread.composer.getState().text) return;
    runtime.thread.composer.setText(draft);
    setDraft("");
  }, [draft, runtime, setDraft]);

  useEffect(() => {
    if (!selectedProvider) return;
    const nextModel = selectedProvider.models.includes(aiSettings.model)
      ? aiSettings.model
      : (selectedProvider.default_model || selectedProvider.models[0] || "");
    if (nextModel && nextModel !== aiSettings.model) {
      updateAiSettings({ model: nextModel });
    }
  }, [aiSettings.model, selectedProvider]);

  if (!isOpen) return null;

  function newInvestigation() {
    runtime.thread.reset();
    setError(null);
    startNewInvestigation();
  }

  function updateAiSettings(patch: Partial<AiAssistantSettings>) {
    setAiSettings((current) => {
      const next = { ...current, ...patch };
      writeAiAssistantSettings(next);
      return next;
    });
  }

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
              onClick={() => setSettingsOpen((open) => !open)}
              aria-label="Copilot settings"
              title="Copilot settings"
            >
              <Settings2 className="size-4" />
            </Button>
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

        <AssistantRuntimeProvider runtime={runtime}>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-hidden">
              {settingsOpen && (
                <div className="border-b border-border-default px-4 py-4">
                  <CopilotSettingsPanel
                    settings={aiSettings}
                    providers={providers.data ?? []}
                    selectedModel={selectedModel}
                    onChange={updateAiSettings}
                  />
                </div>
              )}
              <CopilotThread onNavigate={closeDrawer} />
            </div>

            <ComposerPrimitive.Root className="shrink-0 border-t border-border-default bg-shell p-3">
              <label
                className="block text-[11px] font-medium uppercase tracking-wide text-text-muted"
                htmlFor="copilot-composer"
              >
                Ask Copilot
              </label>
              <ComposerPrimitive.Input
                id="copilot-composer"
                aria-label="Ask Copilot"
                rows={3}
                submitMode="enter"
                className="mt-2 max-h-36 min-h-20 w-full resize-none rounded-control border border-border-default bg-elevated px-3 py-2 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-primary/45"
                placeholder="show latest logs from customer service"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className={cn("text-[11px]", error ? "text-danger" : "text-text-muted")}>
                  {error ?? "CTAs navigate; actions stay on their owning pages."}
                </p>
                <ComposerPrimitive.Send asChild>
                  <Button type="submit" size="sm" aria-label="send">
                    <SendHorizontal className="size-3.5" />
                    Send
                  </Button>
                </ComposerPrimitive.Send>
              </div>
            </ComposerPrimitive.Root>
          </div>
        </AssistantRuntimeProvider>
      </DrawerPanel>
    </>
  );
}

function CopilotThread({ onNavigate }: { onNavigate: () => void }) {
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      <ThreadPrimitive.Viewport className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <ThreadPrimitive.Empty>
          <div className="rounded-control border border-border-default bg-elevated p-3">
            <h2 className="text-[13px] font-semibold text-text-primary">
              Ask about this cluster
            </h2>
            <p className="mt-1 text-[12px] leading-5 text-text-secondary">
              Ask for logs, events, rollout context, incident updates, or where to continue a task. Copilot keeps navigation explicit and avoids mutating cluster state.
            </p>
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages
          components={{
            Message: () => <CopilotMessage onNavigate={onNavigate} />,
          }}
        />
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function CopilotMessage({ onNavigate }: { onNavigate: () => void }) {
  const role = useMessage((message) => message.role);
  const text = useMessage((message) =>
    message.content
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join("\n\n"),
  );
  const isRunning = useMessage((message) => message.status?.type === "running");
  const response = useMessage(
    (message) =>
      (message.metadata?.custom as { copilotResponse?: NativeCopilotResponse } | undefined)
        ?.copilotResponse,
  );
  const isUser = role === "user";

  return (
    <MessagePrimitive.Root
      className={cn("flex w-full flex-col gap-1", isUser ? "items-end" : "items-start")}
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-text-muted">
        {isUser ? "You" : "Copilot"}
      </div>
      <div
        className={cn(
          "max-w-[92%] whitespace-pre-wrap rounded-control border px-3 py-2 text-[12px] leading-5 shadow-sm",
          isUser
            ? "border-primary/35 bg-primary/15 text-text-primary"
            : "border-border-default bg-elevated text-text-secondary",
        )}
      >
        {text || (isRunning ? "Thinking..." : "")}
      </div>
      {!isUser && response && (
        <div className="w-full space-y-3 pt-1">
          <CopilotResponseDetails response={response} onNavigate={onNavigate} />
        </div>
      )}
    </MessagePrimitive.Root>
  );
}

function CopilotResponseDetails({
  response,
  onNavigate,
}: {
  response: NativeCopilotResponse;
  onNavigate: () => void;
}) {
  return (
    <section className="space-y-3" aria-label="Copilot response details">
      {response.target && (
        <div className="space-y-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            target
          </h3>
          <div className="rounded-control border border-border-default bg-elevated px-3 py-2">
            <div className="text-[12px] font-medium text-text-primary">
              {response.target.displayName}
            </div>
            <div className="mt-1 text-[11px] text-text-muted">
              {response.target.source} / score {response.target.score}
            </div>
          </div>
        </div>
      )}

      {response.candidates && response.candidates.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            candidates
          </h3>
          <div className="space-y-2">
            {response.candidates.map((candidate) => (
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
            <CopilotCtaCard key={cta.id} cta={cta} onNavigate={onNavigate} />
          ))}
        </div>
      )}

      {response.details.length > 0 && response.mode !== "ambiguous" && (
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

      {response.evidence && (
        <div className="space-y-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
            evidence
          </h3>
          <div className="space-y-2">
            {[...response.evidence.facts, ...response.evidence.warnings].map((fact) => (
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
  );
}

function CopilotSettingsPanel({
  settings,
  providers,
  selectedModel,
  onChange,
}: {
  settings: AiAssistantSettings;
  providers: Array<{
    id: AiProviderId;
    label: string;
    available: boolean;
    models: string[];
    default_model: string;
  }>;
  selectedModel: string;
  onChange: (patch: Partial<AiAssistantSettings>) => void;
}) {
  const selectedProvider = providers.find((provider) => provider.id === settings.provider);
  const modelOptions = selectedProvider?.models.length
    ? selectedProvider.models
    : [selectedModel || settings.model || ""];

  return (
    <section
      className="space-y-3 rounded-control border border-border-default bg-elevated p-3"
      aria-label="Copilot settings"
    >
      <div>
        <h2 className="text-[13px] font-semibold text-text-primary">Copilot settings</h2>
        <p className="mt-1 text-[11px] leading-4 text-text-secondary">
          Natural-language understanding uses your configured local assistant and only returns a read-only route plan.
        </p>
      </div>

      <label className="flex items-start gap-2 rounded-control border border-border-subtle bg-surface px-3 py-2 text-[12px] text-text-primary">
        <input
          type="checkbox"
          checked={settings.copilotModelIntent}
          onChange={(event) => onChange({ copilotModelIntent: event.target.checked })}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          <span className="block font-medium">Use model to understand requests</span>
          <span className="mt-0.5 block text-[11px] leading-4 text-text-secondary">
            Falls back locally only when the provider is unavailable or returns invalid JSON.
          </span>
        </span>
      </label>

      <div className="grid gap-3">
        <label className="block" htmlFor="copilot-provider">
          <span className="mb-1.5 block text-[10px] uppercase tracking-wide text-text-muted">
            Provider
          </span>
          <select
            id="copilot-provider"
            value={settings.provider}
            onChange={(event) =>
              onChange({ provider: event.target.value === "claude" ? "claude" : "codex" })
            }
            className="h-9 w-full rounded-control border border-border-default bg-surface px-3 text-[12px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>

        <div>
          <label
            className="mb-1.5 block text-[10px] uppercase tracking-wide text-text-muted"
            htmlFor="copilot-model"
          >
            Model
          </label>
          <select
            id="copilot-model"
            value={selectedModel}
            disabled={!modelOptions[0]}
            onChange={(event) => onChange({ model: event.target.value })}
            className="h-9 w-full rounded-control border border-border-default bg-surface px-3 text-[12px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {modelOptions.map((model) => (
              <option key={model || "none"} value={model}>
                {model || "No models detected"}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] text-text-muted">
            {selectedProvider?.available ? "Provider available." : "Provider not detected."}
          </span>
        </div>

        <label className="block" htmlFor="copilot-instructions">
          <span className="mb-1.5 block text-[10px] uppercase tracking-wide text-text-muted">
            Instructions
          </span>
          <textarea
            id="copilot-instructions"
            value={settings.copilotInstructions}
            onChange={(event) => onChange({ copilotInstructions: event.target.value })}
            rows={4}
            className="w-full resize-none rounded-control border border-border-default bg-surface px-3 py-2 text-[12px] leading-5 text-text-primary outline-none placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-primary/45"
          />
        </label>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange({ copilotInstructions: DEFAULT_COPILOT_INSTRUCTIONS })}
          className="justify-self-start"
        >
          Reset instructions
        </Button>
      </div>
    </section>
  );
}

function getLatestUserText(messages: readonly ThreadMessage[]): string {
  const message = [...messages].reverse().find((item) => item.role === "user");
  if (!message) return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n\n");
}

function renderAssistantText(response: NativeCopilotResponse): string {
  return `${response.title}\n\n${response.summary}`;
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
