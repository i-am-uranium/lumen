import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Database,
  FileText,
  ListChecks,
  Loader2,
  Search,
  SendHorizontal,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { useParams, useSearchParams } from "react-router-dom";
import { ai, type AiProviderStatus, type AiRunResult } from "@/lib/ai";
import { k8s, type WorkloadKind, type WorkloadSummary } from "@/lib/k8s";
import { redactForAi } from "@/lib/aiRedaction";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { LumenPage, PanelHeading, SectionPanel } from "@/components/lumen/page";

type AiTask =
  | "ask"
  | "root-cause"
  | "logs"
  | "yaml"
  | "kubectl"
  | "incident";

const TASKS: Array<{
  id: AiTask;
  label: string;
  description: string;
  prompt: string;
}> = [
  {
    id: "ask",
    label: "Ask Lumen",
    description: "Answer a focused infrastructure question from redacted context.",
    prompt: "What should I investigate first in this cluster?",
  },
  {
    id: "root-cause",
    label: "Root cause",
    description: "Correlate workload health, restarts, events, and notes.",
    prompt: "Identify the most likely root cause and the evidence that supports it.",
  },
  {
    id: "logs",
    label: "Log intelligence",
    description: "Summarize pasted logs and extract repeated errors or anomalies.",
    prompt: "Summarize these logs, group repeated errors, and suggest next checks.",
  },
  {
    id: "yaml",
    label: "YAML explanation",
    description: "Explain manifests and highlight Kubernetes anti-patterns.",
    prompt: "Explain this YAML and call out missing probes, risky env vars, and resource issues.",
  },
  {
    id: "kubectl",
    label: "Kubectl commands",
    description: "Generate safe read-only commands for the selected situation.",
    prompt: "Generate safe kubectl commands to inspect this issue. Do not include destructive commands.",
  },
  {
    id: "incident",
    label: "Incident summary",
    description: "Draft a concise incident update and next mitigation steps.",
    prompt: "Write an incident summary with impact, current evidence, and next mitigation steps.",
  },
];

const CONTEXT_KINDS: WorkloadKind[] = ["pod", "deployment", "statefulset", "daemonset", "job"];

export function AiAssistant() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const ctx = decodeURIComponent(params.ctx ?? "");
  const initialTask = parseAiTask(searchParams.get("task")) ?? "root-cause";
  const resourceFocus = useMemo(
    () => ({
      kind: searchParams.get("kind") ?? "",
      namespace: searchParams.get("namespace") ?? "",
      name: searchParams.get("name") ?? "",
    }),
    [searchParams],
  );
  const focusText = resourceFocus.kind && resourceFocus.name
    ? `Focused resource: ${resourceFocus.kind}/${resourceFocus.namespace ? `${resourceFocus.namespace}/` : ""}${resourceFocus.name}`
    : "";
  const [task, setTask] = useState<AiTask>(initialTask);
  const [question, setQuestion] = useState(
    searchParams.get("question") ??
      TASKS.find((t) => t.id === initialTask)!.prompt,
  );
  const [notes, setNotes] = useState(focusText);
  const [provider, setProvider] = useState<"codex" | "claude">("codex");
  const [model, setModel] = useState("");
  const [approved, setApproved] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [promptEdited, setPromptEdited] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AiRunResult | null>(null);

  const providers = useQuery({
    queryKey: ["ai", "providers"],
    queryFn: ai.detectProviders,
    staleTime: 30_000,
  });
  const workloadQueries = useQueries({
    queries: CONTEXT_KINDS.map((kind) => ({
      queryKey: ["k8s", "ai-context", ctx, kind],
      queryFn: () => k8s.listWorkloads("", kind, ctx || undefined),
      staleTime: 15_000,
    })),
  });

  const workloads = useMemo(
    () => workloadQueries.flatMap((q) => q.data ?? []),
    [workloadQueries],
  );
  const contextPack = useMemo(
    () => buildContextPack(ctx, workloads, notes),
    [ctx, workloads, notes],
  );
  const redacted = useMemo(() => redactForAi(contextPack), [contextPack]);
  const basePrompt = useMemo(
    () => buildPrompt(task, question, redacted.text),
    [task, question, redacted.text],
  );
  const [promptDraft, setPromptDraft] = useState(basePrompt);
  const selectedProvider = providers.data?.find((p) => p.id === provider);
  const selectedModel = selectedProvider?.models.includes(model)
    ? model
    : (selectedProvider?.default_model ?? selectedProvider?.models[0] ?? "");
  const loadingContext = workloadQueries.some((q) => q.isLoading);
  const selectedTask = TASKS.find((t) => t.id === task)!;
  const unhealthyCount = workloads.filter(
    (w) => w.health !== "healthy" || (w.restart_count ?? 0) > 0,
  ).length;
  const contextSignals = [
    { label: "Cluster", value: ctx || "unknown" },
    { label: "Namespace", value: resourceFocus.namespace || "all" },
    { label: "Resources", value: `${workloads.length} sampled` },
    {
      label: resourceFocus.name ? "Focus" : "Signals",
      value: resourceFocus.name
        ? `${resourceFocus.kind}/${resourceFocus.name}`
        : `${unhealthyCount} attention`,
    },
  ];
  const redactionCount = redacted.findings.reduce((sum, f) => sum + f.count, 0);
  const prompt = promptDraft;

  useEffect(() => {
    if (!promptEdited) setPromptDraft(basePrompt);
  }, [basePrompt, promptEdited]);

  useEffect(() => {
    if (!selectedProvider) return;
    const nextModel = selectedProvider.models.includes(model)
      ? model
      : (selectedProvider.default_model || selectedProvider.models[0] || "");
    if (nextModel !== model) setModel(nextModel);
  }, [model, selectedProvider]);

  async function copyPrompt() {
    await navigator.clipboard.writeText(prompt);
    toast.success("AI prompt copied");
  }

  async function runProvider() {
    if (!approved || !selectedProvider?.available || running) return;
    setRunning(true);
    setResult(null);
    try {
      const out = await ai.runPrompt(provider, prompt, selectedModel);
      setResult(out);
      if (out.exit_code === 0 && !out.timed_out) {
        toast.success(`${selectedProvider.label} completed`);
      } else {
        toast.error(`${selectedProvider.label} returned a non-zero result`);
      }
    } catch (e) {
      toast.error((e as Error).message ?? String(e));
    } finally {
      setRunning(false);
    }
  }

  function handleQuestionAction() {
    if (!selectedProvider?.available) {
      setShowConfig(true);
      return;
    }
    if (!approved) {
      toast.message("Approve the redacted payload beside the Ask button first");
      return;
    }
    void runProvider();
  }

  return (
    <LumenPage className="max-w-[1760px] gap-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_460px]">
        <div className="space-y-3">
          <ContextStrip
            items={contextSignals}
            loading={loadingContext}
            provider={selectedProvider}
            showConfig={showConfig}
            onToggleConfig={() => setShowConfig((open) => !open)}
          />
          {showConfig && (
            <ConfigurationPanel
              provider={selectedProvider}
              providers={providers.data ?? []}
              value={provider}
              model={selectedModel}
              prompt={prompt}
              promptEdited={promptEdited}
              onChange={(nextProvider) => {
                setProvider(nextProvider);
                setApproved(false);
              }}
              onModelChange={(nextModel) => {
                setModel(nextModel);
                setApproved(false);
              }}
              onPromptChange={(nextPrompt) => {
                setPromptDraft(nextPrompt);
                setPromptEdited(nextPrompt !== basePrompt);
                setApproved(false);
              }}
              onResetPrompt={() => {
                setPromptDraft(basePrompt);
                setPromptEdited(false);
                setApproved(false);
              }}
              onCopy={() => void copyPrompt()}
            />
          )}
          <ApprovalPanel
            approved={approved}
            prompt={prompt}
            byteSize={new Blob([prompt]).size}
            workloads={workloads.length}
            unhealthy={unhealthyCount}
            notes={notes.trim() ? 1 : 0}
            redactionCount={redactionCount}
            redactions={redacted.findings.map((f) => `${f.label}: ${f.count}`)}
            onCopy={() => void copyPrompt()}
          />
          <TaskChooser
            task={task}
            onSelect={(item) => {
              setTask(item.id);
              setQuestion(item.prompt);
              setPromptEdited(false);
              setApproved(false);
              setResult(null);
            }}
          />
          <QuestionPanel
            task={selectedTask}
            question={question}
            notes={notes}
            running={running}
            approved={approved}
            actionLabel={
              !selectedProvider?.available
                ? "Configure provider"
                : approved
                  ? "Ask"
                  : "Review & approve"
            }
            disabled={running}
            onQuestionChange={(value) => {
              setQuestion(value);
              setPromptEdited(false);
              setApproved(false);
            }}
            onNotesChange={(value) => {
              setNotes(value);
              setPromptEdited(false);
              setApproved(false);
            }}
            onApprovedChange={setApproved}
            onRun={handleQuestionAction}
          />
        </div>

        <AnswerPanel
          result={result}
          provider={selectedProvider}
          model={selectedModel}
          question={question}
          running={running}
        />
      </div>
    </LumenPage>
  );
}

function parseAiTask(value: string | null): AiTask | null {
  return TASKS.some((task) => task.id === value) ? (value as AiTask) : null;
}

function ConfigurationPanel({
  provider,
  providers,
  value,
  model,
  prompt,
  promptEdited,
  onChange,
  onModelChange,
  onPromptChange,
  onResetPrompt,
  onCopy,
}: {
  provider?: AiProviderStatus;
  providers: AiProviderStatus[];
  value: "codex" | "claude";
  model: string;
  prompt: string;
  promptEdited: boolean;
  onChange: (value: "codex" | "claude") => void;
  onModelChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onResetPrompt: () => void;
  onCopy: () => void;
}) {
  const install = getProviderInstallHelp(value);
  return (
    <SectionPanel className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(260px,360px)_minmax(0,1fr)]">
        <div className="space-y-3">
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wide text-text-muted">
              Provider
            </div>
            <ProviderPicker providers={providers} value={value} onChange={onChange} />
          </div>

          <label className="block">
            <span className="mb-2 block text-[10px] uppercase tracking-wide text-text-muted">
              Model
            </span>
            <select
              value={model}
              disabled={!provider?.models.length}
              onChange={(event) => onModelChange(event.target.value)}
              className="h-9 w-full rounded-control border border-border-default bg-elevated px-3 text-[12px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {(provider?.models.length ? provider.models : [""]).map((item) => (
                <option key={item || "none"} value={item}>
                  {item || "No models detected"}
                </option>
              ))}
            </select>
          </label>

          {!provider?.available && (
            <div className="rounded-control border border-warning/35 bg-[var(--status-warning-soft)] p-3">
              <div className="flex items-center gap-2 text-[12px] font-semibold text-warning">
                <TriangleAlert className="size-3.5" />
                {install.title}
              </div>
              <p className="mt-1 text-[11px] leading-4 text-text-secondary">
                {install.description}
              </p>
              <pre className="mt-2 overflow-x-auto rounded border border-border-subtle bg-code-surface p-2 font-mono text-[10px] leading-4 text-text-secondary">
                {install.commands.join("\n")}
              </pre>
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-muted">
            <TerminalSquare className="size-3.5 text-accent-primary" />
            Execution preview
          </div>
          <div className="rounded-control border border-border-default bg-code-surface p-3 font-mono text-[11px] leading-5 text-text-secondary">
            {(provider?.command_preview ?? "Select an AI provider").replace(
              "<model>",
              model || provider?.default_model || "model",
            )}
            {provider?.path && <div className="text-text-muted">{provider.path}</div>}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-[12px] text-text-secondary">
            <SafetyLine>Read-only execution</SafetyLine>
            <SafetyLine>No cluster changes</SafetyLine>
            <SafetyLine>Manual command approval</SafetyLine>
          </div>
        </div>
      </div>

      <label className="block">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-wide text-text-muted">
            Prompt
          </span>
          <div className="flex items-center gap-2">
            {promptEdited && (
              <span className="text-[10px] uppercase tracking-wide text-warning">
                customized
              </span>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={onResetPrompt}>
              Reset
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={onCopy}>
              <Clipboard className="size-3.5" /> copy prompt
            </Button>
          </div>
        </div>
        <textarea
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          className="min-h-[180px] w-full resize-y rounded-control border border-border-default bg-code-surface p-3 font-mono text-[11px] leading-5 text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          spellCheck={false}
        />
      </label>
    </SectionPanel>
  );
}

function ContextStrip({
  items,
  loading,
  provider,
  showConfig,
  onToggleConfig,
}: {
  items: Array<{ label: string; value: string }>;
  loading: boolean;
  provider?: AiProviderStatus;
  showConfig: boolean;
  onToggleConfig: () => void;
}) {
  return (
    <section className="rounded-panel border border-border-default bg-shell/80 p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {items.map((item) => (
            <div
              key={item.label}
              className="min-w-0 border-border-subtle px-3 py-2 sm:border-l first:border-l-0"
            >
              <div className="text-[10px] uppercase tracking-wide text-text-muted">
                {item.label}
              </div>
              <div className="mt-1 truncate font-mono text-[12px] text-text-primary">
                {loading && item.label === "Resources" ? "sampling..." : item.value}
              </div>
            </div>
          ))}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-3">
          <div className="inline-flex items-center gap-1.5 rounded-control border border-success/25 bg-[var(--status-success-soft)] px-2 py-1 text-[10px] text-success">
            <ShieldCheck className="size-3" />
            {provider?.available ? `${provider.label} · read-only` : "CLI not detected"}
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={onToggleConfig}>
            <Settings2 className="size-3.5" />
            {showConfig ? "Hide config" : "Configure"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function TaskChooser({
  task,
  onSelect,
}: {
  task: AiTask;
  onSelect: (task: (typeof TASKS)[number]) => void;
}) {
  return (
    <SectionPanel className="p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em] text-text-muted">
            <Bot className="size-3.5" />
            Workflow
          </div>
          <div className="mt-1 text-sm font-semibold text-text-primary">
            Choose what you need
          </div>
        </div>
        <span className="hidden text-[11px] text-text-muted md:block">
          Pick one, ask, review, approve
        </span>
      </div>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {TASKS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item)}
            className={cn(
              "group min-h-[82px] rounded-control border px-3 py-2.5 text-left transition-colors",
              task === item.id
                ? "border-accent-primary/50 bg-accent-primary-soft text-text-primary"
                : "border-border-default bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary",
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  task === item.id ? "bg-accent-primary" : "bg-border-strong",
                )}
              />
              <span className="text-[12px] font-medium">{item.label}</span>
            </div>
            <div className="mt-1 pl-3.5 text-[10px] leading-4 text-text-muted line-clamp-2">
              {item.description}
            </div>
          </button>
        ))}
      </div>
    </SectionPanel>
  );
}

function QuestionPanel({
  task,
  question,
  notes,
  running,
  approved,
  disabled,
  actionLabel,
  onQuestionChange,
  onNotesChange,
  onApprovedChange,
  onRun,
}: {
  task: (typeof TASKS)[number];
  question: string;
  notes: string;
  running: boolean;
  approved: boolean;
  disabled: boolean;
  actionLabel: string;
  onQuestionChange: (value: string) => void;
  onNotesChange: (value: string) => void;
  onApprovedChange: (value: boolean) => void;
  onRun: () => void;
}) {
  return (
    <SectionPanel className="space-y-3">
      <PanelHeading
        eyebrow="Question"
        title={task.label}
        meta={task.description}
        icon={<Search className="size-3.5" />}
      />
      <div className="rounded-control border border-border-default bg-elevated p-2">
        <textarea
          value={question}
          onChange={(e) => onQuestionChange(e.target.value)}
          className="min-h-[84px] w-full resize-y bg-transparent p-2 text-[13px] leading-5 text-text-primary outline-none placeholder:text-text-muted"
        />
        <div className="flex flex-col gap-2 border-t border-border-subtle pt-2 md:flex-row md:items-center md:justify-between">
          <span className="px-2 text-[10px] text-text-muted">
            Answers are advisory; commands are not auto-executed.
          </span>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <label className="flex items-center gap-2 rounded-control border border-accent-primary/30 bg-accent-primary-soft px-3 py-2 text-[12px] text-text-primary">
              <input
                type="checkbox"
                checked={approved}
                onChange={(e) => onApprovedChange(e.target.checked)}
                className="size-4 shrink-0 accent-[var(--accent-primary)]"
              />
              <span>Approve redacted payload</span>
            </label>
            <Button type="button" disabled={disabled} onClick={onRun} className="h-9 px-3">
              {running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <SendHorizontal className="size-4" />
              )}
              {actionLabel}
            </Button>
          </div>
        </div>
      </div>
      <label className="block">
        <span className="text-[11px] text-text-secondary">
          Add logs, YAML, alert text, or incident notes
        </span>
        <textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="Paste evidence here. Tokens, secrets, credentials, and kubeconfig material are redacted before the prompt is built."
          className="mt-2 min-h-[118px] w-full resize-y rounded-control border border-border-default bg-code-surface p-3 font-mono text-[12px] leading-5 text-text-primary outline-none placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-primary/45"
        />
      </label>
    </SectionPanel>
  );
}

type ApprovalPanelProps = {
  approved: boolean;
  prompt: string;
  byteSize: number;
  workloads: number;
  unhealthy: number;
  notes: number;
  redactionCount: number;
  redactions: string[];
  onCopy: () => void;
};

function ApprovalPanel({
  approved,
  prompt,
  byteSize,
  workloads,
  unhealthy,
  notes,
  redactionCount,
  redactions,
  onCopy,
}: ApprovalPanelProps) {
    const [showPayload, setShowPayload] = useState(false);
    return (
      <div>
        <SectionPanel className="space-y-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="rounded-control border border-success/30 bg-[var(--status-success-soft)] p-2 text-success">
                <ShieldCheck className="size-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-text-primary">
                  Review and approve
                </h2>
                <p className="mt-1 text-[12px] text-text-secondary">
                  Lumen sends only the redacted payload after you approve it.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-text-muted">
                {byteSize.toLocaleString()} bytes
              </span>
              <Button type="button" variant="secondary" size="sm" onClick={onCopy}>
                <Clipboard className="size-3.5" /> copy
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShowPayload((open) => !open)}
              >
                <Settings2 className="size-3.5" />
                {showPayload ? "Hide payload" : "View payload"}
              </Button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-4">
            <ReviewStat label="workloads" value={workloads} />
            <ReviewStat label="attention" value={unhealthy} />
            <ReviewStat label="notes" value={notes} />
            <ReviewStat label="redacted" value={redactionCount} />
          </div>

          <div
            className={cn(
              "rounded-control border px-3 py-2 text-[11px]",
              redactions.length
                ? "border-warning/35 bg-[var(--status-warning-soft)] text-warning"
                : "border-success/30 bg-[var(--status-success-soft)] text-success",
            )}
          >
            {redactions.length
              ? `Redacted: ${redactions.join(", ")}`
              : "No sensitive patterns detected. Secrets, tokens, and credentials are still checked before sending."}
          </div>

          {showPayload && (
            <pre className="max-h-[300px] overflow-auto rounded-control border border-border-default bg-code-surface p-3 font-mono text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap">
              {prompt}
            </pre>
          )}

          <div className="border-t border-border-subtle pt-3 text-[12px] text-text-secondary">
            {approved
              ? "Approved. The next run can send this redacted payload to your local AI CLI."
              : "Approve the redacted payload beside the Ask button before running the assistant."}
          </div>
        </SectionPanel>
      </div>
    );
}

function ReviewStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-control border border-border-default bg-elevated px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 font-mono text-[13px] text-text-primary">{value}</div>
    </div>
  );
}

function SafetyLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <CheckCircle2 className="size-3.5 text-success" />
      {children}
    </div>
  );
}

function AnswerPanel({
  result,
  provider,
  model,
  question,
  running,
}: {
  result: AiRunResult | null;
  provider?: AiProviderStatus;
  model: string;
  question: string;
  running: boolean;
}) {
  return (
    <aside className="min-h-[760px] rounded-panel border border-border-default bg-shell/90 p-4 shadow-[var(--shadow-panel)] xl:sticky xl:top-4 xl:max-h-[calc(100vh-7rem)] xl:overflow-auto">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Answer</h2>
          <p className="mt-1 text-[11px] text-text-muted">
            {result
              ? `${result.provider} · ${model || "default"} · exit ${result.exit_code ?? "n/a"}`
              : provider
                ? `${provider.label} · ${model || provider.default_model}`
                : "No provider selected"}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!result?.stdout}
          onClick={() => result?.stdout && navigator.clipboard.writeText(result.stdout)}
        >
          <Clipboard className="size-3.5" /> Copy
        </Button>
      </div>
      <div className="space-y-3">
        {(running || result) && (
          <div className="ml-auto max-w-[92%] rounded-control border border-accent-primary/25 bg-accent-primary-soft p-3">
            <div className="text-[10px] uppercase tracking-wide text-accent-primary">
              You asked
            </div>
            <div className="mt-1 text-[12px] leading-5 text-text-primary">
              {question}
            </div>
          </div>
        )}

        {!result && !running ? (
          <div className="rounded-control border border-border-default bg-elevated p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-control border border-accent-primary/25 bg-accent-primary-soft p-2 text-accent-primary">
                <Sparkles className="size-4" />
              </div>
              <div>
                <div className="text-[13px] font-semibold text-text-primary">
                  Waiting for an approved question
                </div>
                <p className="mt-1 text-[12px] leading-5 text-text-secondary">
                  Approve the redacted payload, then run Ask. The answer will be
                  grouped into summary, evidence, likely cause, next checks, safe
                  commands, remediation, and confirmation-required actions.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {running && (
          <div className="rounded-control border border-border-default bg-elevated p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-control border border-success/25 bg-[var(--status-success-soft)] p-2 text-success">
                <Loader2 className="size-4 animate-spin" />
              </div>
              <div>
                <div className="text-[13px] font-semibold text-text-primary">
                  Analyzing redacted context
                </div>
                <div className="mt-2 grid gap-2 text-[12px] text-text-secondary">
                  <SafetyLine>Building an evidence-only prompt</SafetyLine>
                  <SafetyLine>Running {provider?.label ?? "AI CLI"} in read-only mode</SafetyLine>
                  <SafetyLine>Formatting the result into operator sections</SafetyLine>
                </div>
              </div>
            </div>
          </div>
        )}

        {result ? (
          <div className="rounded-control border border-border-default bg-elevated p-3">
            <div className="mb-3 flex items-center gap-2 text-[12px] font-semibold text-text-primary">
              <Bot className="size-4 text-accent-primary" />
              Lumen assistant
            </div>
            {result.stderr && (
              <div className="mb-3 rounded-control border border-warning/35 bg-[var(--status-warning-soft)] p-3 text-[11px] text-warning whitespace-pre-wrap">
                {result.stderr}
              </div>
            )}
            <StructuredAnswer stdout={result.stdout} />
          </div>
        ) : null}
      </div>
    </aside>
  );
}

type AnswerSection = {
  title: string;
  content: string;
  tone: "summary" | "evidence" | "cause" | "checks" | "commands" | "remediation" | "confirmation";
};

const ANSWER_SECTION_META: Record<
  AnswerSection["tone"],
  { icon: React.ReactNode; className: string }
> = {
  summary: {
    icon: <FileText className="size-4" />,
    className: "border-accent-primary/30 bg-accent-primary-soft text-accent-primary",
  },
  evidence: {
    icon: <Database className="size-4" />,
    className: "border-warning/30 bg-[var(--status-warning-soft)] text-warning",
  },
  cause: {
    icon: <Search className="size-4" />,
    className: "border-danger/30 bg-[var(--status-error-soft)] text-danger",
  },
  checks: {
    icon: <ListChecks className="size-4" />,
    className: "border-info/30 bg-[var(--status-info-soft)] text-info",
  },
  commands: {
    icon: <TerminalSquare className="size-4" />,
    className: "border-success/30 bg-[var(--status-success-soft)] text-success",
  },
  remediation: {
    icon: <ShieldCheck className="size-4" />,
    className: "border-accent-primary/30 bg-accent-primary-soft text-accent-primary",
  },
  confirmation: {
    icon: <TriangleAlert className="size-4" />,
    className: "border-warning/30 bg-[var(--status-warning-soft)] text-warning",
  },
};

function StructuredAnswer({ stdout }: { stdout: string }) {
  const answerText = useMemo(() => extractAssistantAnswer(stdout), [stdout]);
  const sections = useMemo(() => parseAnswerSections(answerText), [answerText]);
  if (!stdout.trim()) {
    return (
      <div className="rounded-control border border-border-default bg-code-surface p-4 text-[12px] text-text-muted">
        No output returned.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sections.length ? (
        sections.map((section) => (
          <AnswerSectionCard key={section.title} section={section} />
        ))
      ) : (
        <MissingStructuredAnswer />
      )}
      <RawTranscript stdout={stdout} />
    </div>
  );
}

function AnswerSectionCard({ section }: { section: AnswerSection }) {
  const meta = ANSWER_SECTION_META[section.tone];
  const lines = normalizeSectionLines(section.content);
  const commandLines =
    section.tone === "commands" || section.tone === "confirmation"
      ? lines.filter(isCommandLine)
      : [];
  const bodyLines = commandLines.length
    ? lines.filter((line) => !commandLines.includes(line))
    : lines;
  const actionLines = section.tone === "remediation" ? lines : [];
  const evidenceItems = section.tone === "evidence" ? lines : [];
  const checklistItems = section.tone === "checks" ? lines : [];
  const summaryLines = section.tone === "summary" ? lines : [];
  const causeLines = section.tone === "cause" ? lines : [];

  return (
    <section className="rounded-control border border-border-default bg-elevated p-3">
      <div className="mb-3 flex items-center gap-2">
        <div className={cn("rounded-control border p-1.5", meta.className)}>
          {meta.icon}
        </div>
        <h3 className="text-[13px] font-semibold text-text-primary">{section.title}</h3>
      </div>

      {section.tone === "evidence" && evidenceItems.length > 0 && (
        <div className="space-y-2">
          {evidenceItems.map((line, index) => (
            <EvidenceRow key={`${line}-${index}`} line={line} />
          ))}
        </div>
      )}

      {section.tone === "remediation" && actionLines.length > 0 && (
        <div className="space-y-2">
          {actionLines.map((line, index) => (
            <SuggestedActionRow
              key={`${line}-${index}`}
              text={line}
              index={index}
            />
          ))}
        </div>
      )}

      {section.tone === "summary" && summaryLines.length > 0 && (
        <div className="rounded-control border border-accent-primary/20 bg-code-surface/60 p-3">
          <div className="text-[12px] font-medium leading-5 text-text-primary">
            {cleanListMarker(summaryLines[0])}
          </div>
          {summaryLines.slice(1).length > 0 && (
            <div className="mt-2 space-y-1">
              {summaryLines.slice(1).map((line, index) => (
                <div
                  key={`${line}-${index}`}
                  className="flex gap-2 text-[12px] leading-5 text-text-secondary"
                >
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-accent-primary" />
                  <span>{cleanListMarker(line)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {section.tone === "cause" && causeLines.length > 0 && (
        <div className="space-y-2">
          {causeLines.map((line, index) => (
            <div
              key={`${line}-${index}`}
              className="rounded-control border border-danger/20 bg-[var(--status-error-soft)] px-3 py-2 text-[12px] leading-5 text-text-secondary"
            >
              {cleanListMarker(line)}
            </div>
          ))}
        </div>
      )}

      {section.tone === "checks" && checklistItems.length > 0 && (
        <div className="space-y-2">
          {checklistItems.map((line, index) => (
            <div
              key={`${line}-${index}`}
              className="flex items-start gap-3 rounded-control border border-border-subtle bg-code-surface/60 px-3 py-2"
            >
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-info/30 bg-[var(--status-info-soft)] text-[10px] font-semibold text-info">
                {index + 1}
              </span>
              <span className="text-[12px] leading-5 text-text-secondary">
                {cleanListMarker(line)}
              </span>
            </div>
          ))}
        </div>
      )}

      {!["evidence", "remediation", "summary", "cause", "checks"].includes(section.tone) && bodyLines.length > 0 && (
        <div className="space-y-2 text-[12px] leading-5 text-text-secondary">
          {bodyLines.map((line) => (
            <p key={line} className="whitespace-pre-wrap">
              {cleanListMarker(line)}
            </p>
          ))}
        </div>
      )}

      {commandLines.length > 0 && (
        <div className="space-y-2">
          {commandLines.map((line, index) => (
            <CommandActionRow
              key={`${line}-${index}`}
              command={line}
              intent={section.tone === "confirmation" ? "warning" : "primary"}
              label={section.tone === "confirmation" ? "Confirm" : "Run"}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function EvidenceRow({ line }: { line: string }) {
  const cleaned = cleanListMarker(line);
  const [label, ...rest] = cleaned.split(/:\s+/);
  const hasLabel = rest.length > 0 && label.length <= 42;
  return (
    <div className="rounded-control border border-border-subtle bg-code-surface/60 px-3 py-2">
      {hasLabel ? (
        <>
          <div className="text-[10px] uppercase tracking-wide text-warning">
            {label}
          </div>
          <div className="mt-1 text-[12px] leading-5 text-text-secondary">
            {rest.join(": ")}
          </div>
        </>
      ) : (
        <div className="text-[12px] leading-5 text-text-secondary">{cleaned}</div>
      )}
    </div>
  );
}

function SuggestedActionRow({ text, index }: { text: string; index: number }) {
  const [confirming, setConfirming] = useState(false);
  const action = cleanListMarker(text);
  async function copyAction() {
    await navigator.clipboard.writeText(action);
    toast.success("Remediation action copied");
    setConfirming(false);
  }
  return (
    <>
      <div className="rounded-control border border-border-subtle bg-code-surface/60 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-accent-primary">
              step {index + 1}
            </div>
            <div className="mt-1 text-[12px] leading-5 text-text-secondary">
              {action}
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            <Clipboard className="size-3.5" /> Copy
          </Button>
        </div>
      </div>
      <ConfirmActionDialog
        open={confirming}
        title="Copy remediation action"
        description="This copies an AI-suggested remediation step. Review it before using it operationally."
        target={action}
        confirmLabel="copy action"
        intent="primary"
        confirmText="copy"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void copyAction()}
      />
    </>
  );
}

function CommandActionRow({
  command,
  intent,
  label,
}: {
  command: string;
  intent: "primary" | "warning";
  label: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const cleaned = cleanCommand(command);
  async function copyCommand() {
    await navigator.clipboard.writeText(cleaned);
    toast.success("Command copied");
    setConfirming(false);
  }
  return (
    <>
      <div className="rounded-control border border-border-subtle bg-code-surface p-2">
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-success">
            {cleaned}
          </code>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => setConfirming(true)}
          >
            <TerminalSquare className="size-3.5" /> {label}
          </Button>
        </div>
      </div>
      <ConfirmActionDialog
        open={confirming}
        title={intent === "warning" ? "Confirm generated command" : "Confirm read-only command"}
        description={
          intent === "warning"
            ? "This command may change cluster state. Lumen will copy it only after confirmation; review it before running in your terminal."
            : "This command is AI-generated. Lumen will copy it only after confirmation; review it before running in your terminal."
        }
        target={cleaned}
        confirmLabel="copy command"
        intent={intent}
        confirmText={intent === "warning" ? cleaned : "copy"}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void copyCommand()}
      />
    </>
  );
}

function normalizeSectionLines(content: string): string[] {
  return content
    .replace(/```(?:bash|sh|shell)?/gi, "")
    .replace(/```/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/^\*\*(.+)\*\*$/, "$1"))
    .filter(Boolean);
}

function isCommandLine(line: string): boolean {
  return /^(?:[-*]\s*)?(?:`{0,3})?(?:kubectl|helm|k9s)\b/i.test(line);
}

function cleanListMarker(line: string): string {
  return line.replace(/^[-*]\s*/, "").replace(/^\d+\.\s*/, "").trim();
}

function cleanCommand(line: string): string {
  return cleanListMarker(line).replace(/^`+|`+$/g, "").trim();
}

function parseAnswerSections(stdout: string): AnswerSection[] {
  const text = stdout.trim();
  if (!text) return [];
  const headings = [
    { label: "Summary", tone: "summary" },
    { label: "Evidence", tone: "evidence" },
    { label: "Most likely cause", tone: "cause" },
    { label: "Next checks", tone: "checks" },
    { label: "Safe kubectl commands", tone: "commands" },
    { label: "Remediation suggestions", tone: "remediation" },
    { label: "Requires confirmation", tone: "confirmation" },
  ] as const;
  const pattern = new RegExp(
    `(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\d+\\.\\s*)?\\*{0,2}(${headings
      .map((h) => h.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})\\*{0,2}\\s*:?\\s*(?:\\n|$)`,
    "gi",
  );
  const matches = Array.from(text.matchAll(pattern));
  if (!matches.length) {
    return [{ title: "Summary", content: text, tone: "summary" }];
  }

  return matches
    .map((match, index) => {
      const title = match[1];
      const start = match.index! + match[0].length;
      const end = matches[index + 1]?.index ?? text.length;
      const meta = headings.find((h) => h.label.toLowerCase() === title.toLowerCase());
      return {
        title: meta?.label ?? title,
        content: text.slice(start, end).trim(),
        tone: meta?.tone ?? "summary",
      };
    })
    .filter((section) => section.content.length > 0);
}

function extractAssistantAnswer(stdout: string): string {
  const text = stripAnsi(stdout).trim();
  if (!text) return "";
  const assistantMarkers = [
    /\nassistant\s*\n+/gi,
    /\nassistant response\s*:?\s*\n+/gi,
    /\nfinal answer\s*:?\s*\n+/gi,
  ];
  for (const marker of assistantMarkers) {
    const matches = Array.from(text.matchAll(marker));
    const last = matches[matches.length - 1];
    if (last?.index !== undefined) {
      const answer = text.slice(last.index + last[0].length).trim();
      if (answer && !looksLikePromptEcho(answer)) return answer;
    }
  }
  return looksLikePromptEcho(text) ? "" : text;
}

function looksLikePromptEcho(text: string): boolean {
  return (
    text.includes("You are Lumen's local Kubernetes assistant.") &&
    text.includes("Redacted context:") &&
    text.includes("Return this structure:")
  );
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function MissingStructuredAnswer() {
  return (
    <section className="rounded-control border border-warning/30 bg-[var(--status-warning-soft)] p-3">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div>
          <h3 className="text-[13px] font-semibold text-text-primary">
            No structured assistant answer detected
          </h3>
          <p className="mt-1 text-[12px] leading-5 text-text-secondary">
            The AI CLI returned a transcript or prompt echo instead of the requested
            answer sections. Expand the raw transcript below to inspect the provider output.
          </p>
        </div>
      </div>
    </section>
  );
}

function RawTranscript({
  stdout,
}: {
  stdout: string;
}) {
  return (
    <details
      className="group rounded-control border border-border-default bg-shell/75"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-[12px] text-text-secondary">
        <span className="font-medium text-text-primary">Raw transcript</span>
        <span className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-muted">
          collapsed by default
          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <pre className="max-h-[360px] overflow-auto border-t border-border-subtle bg-code-surface p-3 font-mono text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap">
        {stripAnsi(stdout)}
      </pre>
    </details>
  );
}

function ProviderPicker({
  providers,
  value,
  onChange,
}: {
  providers: AiProviderStatus[];
  value: "codex" | "claude";
  onChange: (value: "codex" | "claude") => void;
}) {
  return (
    <div className="flex rounded-control border border-border-default bg-elevated p-1">
      {(["codex", "claude"] as const).map((id) => {
        const p = providers.find((item) => item.id === id);
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={cn(
              "flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] transition-colors",
              active
                ? "bg-accent-primary text-white"
                : "text-text-secondary hover:bg-hover hover:text-text-primary",
            )}
          >
            {p?.available ? (
              <CheckCircle2 className="size-3.5" />
            ) : (
              <TriangleAlert className="size-3.5" />
            )}
            {id}
          </button>
        );
      })}
    </div>
  );
}

function getProviderInstallHelp(provider: "codex" | "claude") {
  if (provider === "claude") {
    return {
      title: "Claude Code CLI not found",
      description:
        "Install Claude Code, sign in, then restart Lumen so the desktop app can see the updated PATH.",
      commands: [
        "npm install -g @anthropic-ai/claude-code",
        "claude auth login",
        "which claude",
      ],
    };
  }
  return {
    title: "Codex CLI not found",
    description:
      "Install Codex CLI, sign in, then restart Lumen so the desktop app can see the updated PATH.",
    commands: [
      "npm install -g @openai/codex",
      "codex login",
      "which codex",
    ],
  };
}

function buildContextPack(
  ctx: string,
  workloads: WorkloadSummary[],
  notes: string,
): string {
  const unhealthy = workloads
    .filter((w) => w.health !== "healthy" || (w.restart_count ?? 0) > 0)
    .slice(0, 35);
  const topConsumers = workloads
    .filter((w) => w.cpu_milli || w.mem_bytes)
    .sort((a, b) => (b.mem_bytes ?? 0) - (a.mem_bytes ?? 0))
    .slice(0, 12);

  return [
    `cluster: ${ctx || "unknown"}`,
    "",
    "unhealthy_or_restarted_resources:",
    unhealthy.length
      ? unhealthy.map(formatWorkload).join("\n")
      : "none observed in sampled resources",
    "",
    "top_memory_consumers:",
    topConsumers.length
      ? topConsumers.map(formatWorkload).join("\n")
      : "no metrics available",
    "",
    "operator_notes:",
    notes.trim() || "none",
  ].join("\n");
}

function formatWorkload(w: WorkloadSummary): string {
  return [
    `- ${w.kind}/${w.namespace}/${w.name}`,
    `health=${w.health}`,
    `ready=${w.ready || "-"}`,
    `phase=${w.pod_phase ?? "-"}`,
    `restarts=${w.restart_count ?? 0}`,
    `node=${w.node_name ?? "-"}`,
    `cpu_milli=${w.cpu_milli ?? "-"}`,
    `mem_bytes=${w.mem_bytes ?? "-"}`,
  ].join(" ");
}

function buildPrompt(task: AiTask, question: string, context: string): string {
  const taskLabel = TASKS.find((t) => t.id === task)?.label ?? "Ask Lumen";
  return `You are Lumen's local Kubernetes assistant.

Rules:
- Be concise, technical, and evidence-driven.
- Do not execute commands or imply that commands were executed.
- Only suggest destructive or mutating commands in a separate "Requires confirmation" section.
- Prefer read-only kubectl commands for investigation.
- If evidence is insufficient, say exactly what is missing.
- Do not expose secrets; the context was redacted and may omit sensitive values.

Task: ${taskLabel}
Operator question:
${question.trim() || "Analyze the provided Kubernetes context."}

Return this structure:
Use these exact section headings, each on its own line, without markdown fences:
Summary
Evidence
Most likely cause
Next checks
Safe kubectl commands
Remediation suggestions
Requires confirmation

Formatting rules:
- Keep Summary to 1-3 short sentences.
- Make Evidence a bullet list of concrete signals.
- Make Next checks and Remediation suggestions actionable bullet lists.
- Put one command per line in Safe kubectl commands.
- Put mutating commands only in Requires confirmation, one command per line.
- If a section has nothing useful, write "None."

Redacted context:
${context}`;
}
