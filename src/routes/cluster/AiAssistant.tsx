import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
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
import { useParams } from "react-router-dom";
import { ai, type AiProviderStatus, type AiRunResult } from "@/lib/ai";
import { k8s, type WorkloadKind, type WorkloadSummary } from "@/lib/k8s";
import { redactForAi } from "@/lib/aiRedaction";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
  const ctx = decodeURIComponent(params.ctx ?? "");
  const [task, setTask] = useState<AiTask>("root-cause");
  const [question, setQuestion] = useState(TASKS.find((t) => t.id === "root-cause")!.prompt);
  const [notes, setNotes] = useState("");
  const [provider, setProvider] = useState<"codex" | "claude">("codex");
  const [approved, setApproved] = useState(false);
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
  const prompt = useMemo(
    () => buildPrompt(task, question, redacted.text),
    [task, question, redacted.text],
  );
  const selectedProvider = providers.data?.find((p) => p.id === provider);
  const loadingContext = workloadQueries.some((q) => q.isLoading);
  const selectedTask = TASKS.find((t) => t.id === task)!;
  const unhealthyCount = workloads.filter(
    (w) => w.health !== "healthy" || (w.restart_count ?? 0) > 0,
  ).length;
  const contextSignals = [
    { label: "Cluster", value: ctx || "unknown" },
    { label: "Namespace", value: "all" },
    { label: "Resources", value: `${workloads.length} sampled` },
    { label: "Signals", value: `${unhealthyCount} attention` },
  ];
  const reviewTabs = [
    { label: "Workloads", count: workloads.length },
    { label: "Unhealthy", count: unhealthyCount },
    { label: "Notes", count: notes.trim() ? 1 : 0 },
    { label: "Redacted", count: redacted.findings.reduce((sum, f) => sum + f.count, 0) },
  ];
  const sampleRows = workloads
    .filter((w) => w.health !== "healthy" || (w.restart_count ?? 0) > 0)
    .slice(0, 8);

  async function copyPrompt() {
    await navigator.clipboard.writeText(prompt);
    toast.success("AI prompt copied");
  }

  async function runProvider() {
    if (!approved || !selectedProvider?.available || running) return;
    setRunning(true);
    setResult(null);
    try {
      const out = await ai.runPrompt(provider, prompt);
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

  return (
    <LumenPage className="max-w-[1760px] gap-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_460px]">
        <div className="space-y-3">
          <AssistantHero
            provider={selectedProvider}
            providers={providers.data ?? []}
            value={provider}
            onChange={setProvider}
          />
          <TaskChooser
            task={task}
            onSelect={(item) => {
              setTask(item.id);
              setQuestion(item.prompt);
              setApproved(false);
              setResult(null);
            }}
          />
          <QuestionPanel
            task={selectedTask}
            question={question}
            notes={notes}
            running={running}
            disabled={!approved || !selectedProvider?.available || running}
            onQuestionChange={(value) => {
              setQuestion(value);
              setApproved(false);
            }}
            onNotesChange={(value) => {
              setNotes(value);
              setApproved(false);
            }}
            onRun={() => void runProvider()}
          />
          <ContextStrip items={contextSignals} loading={loadingContext} />

          <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_360px]">
            <ReviewPanel
              tabs={reviewTabs}
              rows={sampleRows}
              prompt={prompt}
              redactions={redacted.findings.map((f) => `${f.label}: ${f.count}`)}
              byteSize={new Blob([prompt]).size}
              loading={loadingContext}
            />
            <div className="space-y-3">
              <PreviewPane
                title="Redaction report"
                empty="No sensitive patterns detected"
                content={
                  redacted.findings.length
                    ? redacted.findings.map((f) => `${f.label}: ${f.count}`).join("\n")
                    : ""
                }
                tone={redacted.findings.length ? "warning" : "success"}
              />
              <ExecutionPreview
                provider={selectedProvider}
                approved={approved}
                onApprovedChange={setApproved}
                onCopy={() => void copyPrompt()}
              />
            </div>
          </div>
        </div>

        <AnswerPanel result={result} provider={selectedProvider} />
      </div>
    </LumenPage>
  );
}

function AssistantHero({
  provider,
  providers,
  value,
  onChange,
}: {
  provider?: AiProviderStatus;
  providers: AiProviderStatus[];
  value: "codex" | "claude";
  onChange: (value: "codex" | "claude") => void;
}) {
  return (
    <section className="relative overflow-hidden rounded-panel border border-accent-primary/40 bg-[linear-gradient(135deg,rgba(99,102,241,0.18),rgba(16,185,129,0.06)_45%,rgba(13,15,20,0.92))] p-4 shadow-[var(--shadow-panel)]">
      <div className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--accent-primary),transparent)]" />
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-accent-primary">
            <Sparkles className="size-4" />
            AI assistant
          </div>
          <h1 className="mt-2 text-2xl font-semibold leading-tight text-text-primary">
            Ask Lumen
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Local-first debugging with redacted context, explicit approval, and
            read-only execution through your installed AI CLI.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <span className="text-[10px] uppercase tracking-wide text-text-muted">
            Provider
          </span>
          <ProviderPicker providers={providers} value={value} onChange={onChange} />
          <div className="inline-flex items-center gap-1.5 self-start rounded-control border border-success/25 bg-[var(--status-success-soft)] px-2 py-1 text-[10px] text-success">
            <ShieldCheck className="size-3" />
            {provider?.available ? "Read-only mode" : "CLI not detected"}
          </div>
        </div>
      </div>
    </section>
  );
}

function ContextStrip({
  items,
  loading,
}: {
  items: Array<{ label: string; value: string }>;
  loading: boolean;
}) {
  return (
    <section className="rounded-panel border border-border-default bg-shell/80 p-3">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
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
  disabled,
  onQuestionChange,
  onNotesChange,
  onRun,
}: {
  task: (typeof TASKS)[number];
  question: string;
  notes: string;
  running: boolean;
  disabled: boolean;
  onQuestionChange: (value: string) => void;
  onNotesChange: (value: string) => void;
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
        <div className="flex items-center justify-between border-t border-border-subtle pt-2">
          <span className="px-2 text-[10px] text-text-muted">
            Answers are advisory; commands are not auto-executed.
          </span>
          <Button type="button" disabled={disabled} onClick={onRun} className="h-9 px-3">
            {running ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <SendHorizontal className="size-4" />
            )}
            {disabled ? "Review first" : "Ask"}
          </Button>
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

function ReviewPanel({
  tabs,
  rows,
  prompt,
  redactions,
  byteSize,
  loading,
}: {
  tabs: Array<{ label: string; count: number }>;
  rows: WorkloadSummary[];
  prompt: string;
  redactions: string[];
  byteSize: number;
  loading: boolean;
}) {
  const [view, setView] = useState<"summary" | "payload">("summary");
  return (
    <SectionPanel className="overflow-hidden p-0">
      <div className="flex flex-col gap-3 border-b border-border-default p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-control border border-success/30 bg-[var(--status-success-soft)] p-2 text-success">
            <ShieldCheck className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">
              Review before sending
            </h2>
            <p className="mt-1 text-[12px] text-text-secondary">
              Lumen uses sampled cluster context and redacts sensitive values.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-text-muted">
            {byteSize.toLocaleString()} bytes
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setView(view === "summary" ? "payload" : "summary")}
          >
            <Settings2 className="size-3.5" />
            {view === "summary" ? "View payload" : "View summary"}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-b border-border-subtle px-4 py-3">
        {tabs.map((tab) => (
          <span
            key={tab.label}
            className="inline-flex items-center gap-2 rounded-control border border-border-default bg-elevated px-3 py-1.5 text-[11px] text-text-secondary"
          >
            {tab.label}
            <span className="rounded bg-accent-primary-soft px-1.5 py-0.5 font-mono text-[10px] text-accent-primary">
              {tab.count}
            </span>
          </span>
        ))}
      </div>
      {view === "summary" ? (
        <div className="p-4">
          <div className="rounded-control border border-border-default bg-code-surface">
            <div className="grid grid-cols-[minmax(160px,1.1fr)_90px_90px_90px_minmax(120px,0.9fr)] border-b border-border-subtle px-3 py-2 text-[10px] uppercase tracking-wide text-text-muted">
              <span>Resource</span>
              <span>Health</span>
              <span>Ready</span>
              <span>Restarts</span>
              <span>Node</span>
            </div>
            {loading ? (
              <div className="p-4 text-[12px] text-text-secondary">Sampling resources...</div>
            ) : rows.length ? (
              rows.map((row) => (
                <div
                  key={`${row.kind}/${row.namespace}/${row.name}`}
                  className="grid grid-cols-[minmax(160px,1.1fr)_90px_90px_90px_minmax(120px,0.9fr)] border-b border-border-subtle px-3 py-2 text-[11px] last:border-b-0"
                >
                  <span className="truncate font-mono text-text-primary">
                    {row.kind}/{row.name}
                  </span>
                  <span className={cn("capitalize", row.health === "healthy" ? "text-success" : "text-warning")}>
                    {row.health}
                  </span>
                  <span className="font-mono text-text-secondary">{row.ready || "-"}</span>
                  <span className="font-mono text-text-secondary">{row.restart_count ?? 0}</span>
                  <span className="truncate font-mono text-text-muted">{row.node_name ?? "-"}</span>
                </div>
              ))
            ) : (
              <div className="p-4 text-[12px] text-text-secondary">
                No unhealthy or restarted workloads in the sampled context.
              </div>
            )}
          </div>
          <div className="mt-3 rounded-control border border-danger/25 bg-[var(--status-error-soft)] px-3 py-2 text-[11px] text-danger">
            {redactions.length
              ? `Redacted: ${redactions.join(", ")}`
              : "Secrets, tokens, and sensitive values are checked before sending."}
          </div>
        </div>
      ) : (
        <pre className="max-h-[420px] overflow-auto p-4 font-mono text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap">
          {prompt}
        </pre>
      )}
    </SectionPanel>
  );
}

function ExecutionPreview({
  provider,
  approved,
  onApprovedChange,
  onCopy,
}: {
  provider?: AiProviderStatus;
  approved: boolean;
  onApprovedChange: (value: boolean) => void;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-panel border border-border-default bg-shell/80 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
        <TerminalSquare className="size-4 text-accent-primary" />
        Execution preview
      </div>
      <div className="rounded-control border border-border-default bg-code-surface p-3 font-mono text-[11px] leading-5 text-text-secondary">
        {provider?.command_preview ?? "Select an AI provider"}
        {provider?.path && <div className="text-text-muted">{provider.path}</div>}
      </div>
      <div className="mt-3 space-y-2 text-[12px] text-text-secondary">
        <SafetyLine>Read-only execution</SafetyLine>
        <SafetyLine>No cluster changes</SafetyLine>
        <SafetyLine>Commands require manual approval</SafetyLine>
      </div>
      <label className="mt-4 flex items-start gap-2 border-t border-border-subtle pt-3 text-[12px] text-text-secondary">
        <input
          type="checkbox"
          checked={approved}
          onChange={(e) => onApprovedChange(e.target.checked)}
          className="mt-0.5"
        />
        I reviewed the redacted payload and approve sending it to my local AI CLI.
      </label>
      <Button type="button" variant="secondary" className="mt-3 w-full" onClick={onCopy}>
        <Clipboard className="size-4" /> copy prompt
      </Button>
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
}: {
  result: AiRunResult | null;
  provider?: AiProviderStatus;
}) {
  return (
    <aside className="min-h-[760px] rounded-panel border border-border-default bg-shell/90 p-4 shadow-[var(--shadow-panel)] xl:sticky xl:top-4 xl:max-h-[calc(100vh-7rem)] xl:overflow-auto">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Answer</h2>
          <p className="mt-1 text-[11px] text-text-muted">
            {result ? `${result.provider} exit ${result.exit_code ?? "n/a"}` : provider?.label ?? "No provider selected"}
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
      {!result ? (
        <div className="space-y-3">
          <AnswerSkeleton
            title="Summary"
            icon={<FileText className="size-4 text-accent-primary" />}
            lines={[
              "Run the assistant to get a focused operator answer.",
              "Output is structured for evidence, next checks, safe commands, and remediation.",
            ]}
          />
          <AnswerSkeleton
            title="Evidence"
            icon={<Database className="size-4 text-warning" />}
            lines={[
              "Cluster context, pasted logs, events, YAML, and notes appear here after review.",
              "Sensitive values remain redacted.",
            ]}
          />
          <AnswerSkeleton
            title="Safe commands"
            icon={<ListChecks className="size-4 text-success" />}
            lines={[
              "Generated kubectl commands are advisory.",
              "Lumen does not execute them from this panel.",
            ]}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {result.stderr && (
            <div className="rounded-control border border-warning/35 bg-[var(--status-warning-soft)] p-3 text-[11px] text-warning whitespace-pre-wrap">
              {result.stderr}
            </div>
          )}
          <pre className="min-h-[520px] overflow-auto rounded-control border border-border-default bg-code-surface p-3 text-[12px] leading-relaxed text-text-primary whitespace-pre-wrap">
            {result.stdout || "no output"}
          </pre>
        </div>
      )}
    </aside>
  );
}

function AnswerSkeleton({
  title,
  icon,
  lines,
}: {
  title: string;
  icon: React.ReactNode;
  lines: string[];
}) {
  return (
    <section className="rounded-control border border-border-default bg-elevated p-4">
      <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-text-primary">
        {icon}
        {title}
      </div>
      <div className="space-y-2 text-[12px] leading-5 text-text-secondary">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </section>
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

function PreviewPane({
  title,
  content,
  empty,
  tone,
}: {
  title: string;
  content?: string;
  empty: string;
  tone: "success" | "warning";
}) {
  return (
    <div className="rounded-control border border-border-default bg-elevated p-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-muted">
        {tone === "success" ? (
          <CheckCircle2 className="size-3 text-success" />
        ) : (
          <TriangleAlert className="size-3 text-warning" />
        )}
        {title}
      </div>
      <pre className="mt-2 min-h-[54px] whitespace-pre-wrap break-all font-mono text-[11px] text-text-secondary">
        {content || empty}
      </pre>
    </div>
  );
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
1. Summary
2. Evidence
3. Most likely cause
4. Next checks
5. Safe kubectl commands
6. Remediation suggestions
7. Requires confirmation

Redacted context:
${context}`;
}
