import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
  Clipboard,
  Loader2,
  Play,
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
import { LumenPage, PageHeader, PanelHeading, SectionPanel } from "@/components/lumen/page";

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
    <LumenPage>
      <PageHeader
        eyebrow="AI assistant"
        title="Ask Lumen"
        icon={<Sparkles className="size-4" />}
        description="Local-first Kubernetes assistance using your installed Codex or Claude CLI. Lumen redacts context, shows the exact payload, and only runs after approval."
        actions={
          <ProviderPicker
            providers={providers.data ?? []}
            value={provider}
            onChange={setProvider}
          />
        }
      />

      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_420px]">
        <SectionPanel className="space-y-3">
          <PanelHeading eyebrow="mode" title="assistant task" icon={<Bot className="size-3.5" />} />
          <div className="space-y-1">
            {TASKS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setTask(item.id);
                  setQuestion(item.prompt);
                  setApproved(false);
                  setResult(null);
                }}
                className={cn(
                  "w-full rounded-control border px-3 py-2 text-left transition-colors",
                  task === item.id
                    ? "border-accent-primary/50 bg-accent-primary-soft text-text-primary"
                    : "border-border-default bg-elevated text-text-secondary hover:bg-hover hover:text-text-primary",
                )}
              >
                <div className="text-[12px] font-medium">{item.label}</div>
                <div className="mt-0.5 text-[10px] leading-4 text-text-muted">
                  {item.description}
                </div>
              </button>
            ))}
          </div>
        </SectionPanel>

        <SectionPanel className="flex min-h-[720px] flex-col gap-4">
          <PanelHeading
            eyebrow="context"
            title="review before sending"
            meta={loadingContext ? "loading cluster context..." : `${workloads.length} resources sampled`}
            icon={loadingContext ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
          />

          <label className="block">
            <span className="text-[11px] text-text-secondary">Question or objective</span>
            <textarea
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
                setApproved(false);
              }}
              className="mt-2 min-h-[88px] w-full resize-y rounded-control border border-border-default bg-elevated p-3 text-[13px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
            />
          </label>

          <label className="block">
            <span className="text-[11px] text-text-secondary">
              Optional logs, YAML, alert text, or notes
            </span>
            <textarea
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                setApproved(false);
              }}
              placeholder="Paste logs, YAML, event output, or incident notes here. Secrets and token-like values are redacted before the prompt is built."
              className="mt-2 min-h-[170px] w-full resize-y rounded-control border border-border-default bg-elevated p-3 font-mono text-[12px] text-text-primary outline-none placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-primary/45"
            />
          </label>

          <div className="grid gap-3 lg:grid-cols-2">
            <PreviewPane
              title="redaction report"
              empty="no sensitive patterns detected"
              content={
                redacted.findings.length
                  ? redacted.findings.map((f) => `${f.label}: ${f.count}`).join("\n")
                  : ""
              }
              tone={redacted.findings.length ? "warning" : "success"}
            />
            <PreviewPane
              title="provider command"
              empty="provider not detected"
              content={
                selectedProvider?.available
                  ? `${selectedProvider.command_preview}\n${selectedProvider.path ?? ""}`
                  : selectedProvider?.command_preview
              }
              tone={selectedProvider?.available ? "success" : "warning"}
            />
          </div>

          <div className="min-h-0 flex-1 rounded-control border border-border-default bg-code-surface">
            <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
              <span className="text-[11px] uppercase tracking-wide text-text-muted">
                payload preview
              </span>
              <span className="text-[10px] text-text-muted">
                {new Blob([prompt]).size.toLocaleString()} bytes
              </span>
            </div>
            <pre className="max-h-[420px] overflow-auto p-3 font-mono text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap">
              {prompt}
            </pre>
          </div>

          <div className="flex flex-col gap-3 border-t border-border-subtle pt-3 sm:flex-row sm:items-center">
            <label className="flex min-w-0 flex-1 items-start gap-2 text-[12px] text-text-secondary">
              <input
                type="checkbox"
                checked={approved}
                onChange={(e) => setApproved(e.target.checked)}
                className="mt-0.5"
              />
              I reviewed the redacted payload and approve sending it to my local AI CLI.
            </label>
            <Button type="button" variant="secondary" onClick={() => void copyPrompt()}>
              <Clipboard className="size-4" /> copy prompt
            </Button>
            <Button
              type="button"
              disabled={!approved || !selectedProvider?.available || running}
              onClick={() => void runProvider()}
            >
              {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              run local AI
            </Button>
          </div>
        </SectionPanel>

        <SectionPanel className="min-h-[720px]">
          <PanelHeading
            eyebrow="answer"
            title="structured output"
            icon={<TerminalSquare className="size-3.5" />}
            meta={result ? `${result.provider} exit ${result.exit_code ?? "n/a"}` : null}
          />
          {!result ? (
            <div className="rounded-control border border-border-default bg-elevated p-4 text-[12px] leading-5 text-text-secondary">
              The assistant will return a concise operator response: summary, evidence,
              next checks, safe commands, and remediation suggestions. Lumen never runs
              the suggested kubectl commands automatically.
            </div>
          ) : (
            <div className="space-y-3">
              {result.stderr && (
                <div className="rounded-control border border-warning/35 bg-[var(--status-warning-soft)] p-3 text-[11px] text-warning whitespace-pre-wrap">
                  {result.stderr}
                </div>
              )}
              <pre className="max-h-[620px] overflow-auto rounded-control border border-border-default bg-code-surface p-3 text-[12px] leading-relaxed text-text-primary whitespace-pre-wrap">
                {result.stdout || "no output"}
              </pre>
            </div>
          )}
        </SectionPanel>
      </div>
    </LumenPage>
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
