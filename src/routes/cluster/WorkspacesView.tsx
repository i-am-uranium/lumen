import { useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowRight,
  BookOpenCheck,
  Check,
  ClipboardCheck,
  Edit3,
  ListChecks,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  LumenPage,
  PageHeader,
  PanelHeading,
  SectionPanel,
} from "@/components/lumen/page";
import { cn } from "@/lib/utils";
import {
  buildWorkspaceRestoreUrl,
  useWorkspacesStore,
  type SavedWorkspace,
  type WorkspaceInput,
} from "@/state/workspaces";
import {
  buildRunbookStepUrl,
  useRunbooksStore,
  type RunbookInput,
  type RunbookStep,
  type RunbookStepKind,
  type SavedRunbook,
} from "@/state/runbooks";

const STEP_KINDS: Array<{ value: RunbookStepKind; label: string }> = [
  { value: "open-route", label: "open route" },
  { value: "open-resource", label: "open resource" },
  { value: "open-logs", label: "open logs" },
  { value: "port-forward", label: "port-forward prompt" },
  { value: "ask-ai", label: "ask AI" },
  { value: "checklist", label: "checklist" },
];

function emptyWorkspace(context: string): WorkspaceInput {
  return {
    name: "",
    context,
    namespace: "",
    route: "workloads",
    search: "",
    notes: "",
  };
}

function defaultStep(kind: RunbookStepKind = "checklist"): RunbookStep {
  return {
    id: `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    title: kind === "checklist" ? "Confirm state" : "Open target",
    route: kind === "open-route" ? "workloads" : undefined,
    resource:
      kind === "open-resource"
        ? { kind: "deployment", namespace: "default", name: "" }
        : undefined,
    logs:
      kind === "open-logs"
        ? { kind: "deployment", namespace: "default", name: "", filter: "" }
        : undefined,
    prompt: kind === "ask-ai" ? "Summarize the likely cause from this context." : undefined,
    note:
      kind === "checklist" || kind === "port-forward"
        ? "Record the expected operator check."
        : undefined,
  };
}

function emptyRunbook(): RunbookInput {
  return {
    name: "",
    description: "",
    steps: [
      {
        ...defaultStep("open-route"),
        id: "step-open-workloads",
        title: "Open workloads",
      },
      {
        ...defaultStep("checklist"),
        id: "step-confirm-owner",
        title: "Confirm owner and blast radius",
      },
    ],
  };
}

export function WorkspacesView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const navigate = useNavigate();
  const location = useLocation();

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const addWorkspace = useWorkspacesStore((s) => s.addWorkspace);
  const updateWorkspace = useWorkspacesStore((s) => s.updateWorkspace);
  const deleteWorkspace = useWorkspacesStore((s) => s.deleteWorkspace);

  const runbooks = useRunbooksStore((s) => s.runbooks);
  const activeRun = useRunbooksStore((s) => s.activeRun);
  const addRunbook = useRunbooksStore((s) => s.addRunbook);
  const updateRunbook = useRunbooksStore((s) => s.updateRunbook);
  const deleteRunbook = useRunbooksStore((s) => s.deleteRunbook);
  const startRunbook = useRunbooksStore((s) => s.startRunbook);
  const completeStep = useRunbooksStore((s) => s.completeStep);
  const setCurrentStep = useRunbooksStore((s) => s.setCurrentStep);
  const resetRun = useRunbooksStore((s) => s.resetRun);

  const [workspaceEditingId, setWorkspaceEditingId] = useState<string | null>(
    null,
  );
  const [workspaceDraft, setWorkspaceDraft] = useState<WorkspaceInput>(() =>
    emptyWorkspace(context),
  );
  const [runbookEditingId, setRunbookEditingId] = useState<string | null>(null);
  const [runbookDraft, setRunbookDraft] = useState<RunbookInput>(() =>
    emptyRunbook(),
  );

  const currentClusterWorkspaces = useMemo(
    () =>
      workspaces.filter((workspace) => workspace.context === context || !context),
    [workspaces, context],
  );
  const activeRunbook = useMemo(
    () => runbooks.find((runbook) => runbook.id === activeRun?.runbookId),
    [activeRun?.runbookId, runbooks],
  );

  function saveWorkspace() {
    try {
      if (workspaceEditingId) {
        updateWorkspace(workspaceEditingId, workspaceDraft);
        toast.success("workspace updated");
      } else {
        addWorkspace(workspaceDraft);
        toast.success("workspace saved");
      }
      setWorkspaceEditingId(null);
      setWorkspaceDraft(emptyWorkspace(context));
    } catch (error) {
      toast.error((error as Error).message ?? String(error));
    }
  }

  function editWorkspace(workspace: SavedWorkspace) {
    setWorkspaceEditingId(workspace.id);
    setWorkspaceDraft({
      name: workspace.name,
      context: workspace.context,
      namespace: workspace.namespace,
      route: workspace.route,
      search: workspace.search,
      selectedResource: workspace.selectedResource,
      logQuery: workspace.logQuery,
      notes: workspace.notes,
    });
  }

  function saveRunbook() {
    try {
      if (runbookEditingId) {
        updateRunbook(runbookEditingId, runbookDraft);
        toast.success("runbook updated");
      } else {
        addRunbook(runbookDraft);
        toast.success("runbook saved");
      }
      setRunbookEditingId(null);
      setRunbookDraft(emptyRunbook());
    } catch (error) {
      toast.error((error as Error).message ?? String(error));
    }
  }

  function editRunbook(runbook: SavedRunbook) {
    setRunbookEditingId(runbook.id);
    setRunbookDraft({
      name: runbook.name,
      description: runbook.description,
      steps: runbook.steps.map((step) => ({ ...step })),
    });
  }

  function runStep(step: RunbookStep) {
    const target = buildRunbookStepUrl(step, context);
    if (target) navigate(target);
    setCurrentStep(step.id);
  }

  return (
    <LumenPage>
      <PageHeader
        eyebrow="Saved operations"
        title="Workspaces + runbooks"
        icon={<BookOpenCheck className="size-3.5" aria-hidden="true" />}
        description={`${context} · ${currentClusterWorkspaces.length} workspace${currentClusterWorkspaces.length === 1 ? "" : "s"} · ${runbooks.length} runbook${runbooks.length === 1 ? "" : "s"}`}
        actions={
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              setWorkspaceDraft({
                ...emptyWorkspace(context),
                name: `${context} · ${location.pathname.split("/").slice(3).join("/") || "workloads"}`,
                route: `${location.pathname}${location.search}`,
              })
            }
          >
            <Plus className="size-3.5" />
            stage current route
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <SectionPanel>
          <PanelHeading
            eyebrow="Workspaces"
            title="Saved cluster contexts"
            icon={<ClipboardCheck className="size-3.5" />}
            meta={`${currentClusterWorkspaces.length} saved`}
          />
          {currentClusterWorkspaces.length === 0 ? (
            <EmptyState text="No saved workspaces for this cluster yet." />
          ) : (
            <div className="space-y-2">
              {currentClusterWorkspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className="rounded-control border border-border-subtle bg-elevated p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-[13px] font-semibold text-text-primary">
                        {workspace.name}
                      </h3>
                      <p className="mt-1 truncate font-mono text-[11px] text-text-muted">
                        {workspace.context} · {workspace.route}
                      </p>
                      <p className="mt-1 text-[11px] text-text-secondary">
                        {workspace.namespace || "all namespaces"}
                        {workspace.search ? ` · ${workspace.search}` : ""}
                      </p>
                      {workspace.notes && (
                        <p className="mt-2 text-[12px] text-text-secondary">
                          {workspace.notes}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <IconButton
                        label="restore workspace"
                        onClick={() => navigate(buildWorkspaceRestoreUrl(workspace))}
                        icon={<ArrowRight className="size-3.5" />}
                      />
                      <IconButton
                        label="edit workspace"
                        onClick={() => editWorkspace(workspace)}
                        icon={<Edit3 className="size-3.5" />}
                      />
                      <IconButton
                        label="delete workspace"
                        onClick={() => deleteWorkspace(workspace.id)}
                        icon={<Trash2 className="size-3.5" />}
                        danger
                      />
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] text-text-muted">
                    updated {formatDate(workspace.updatedAt)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionPanel>

        <SectionPanel className="self-start">
          <PanelHeading
            eyebrow={workspaceEditingId ? "Edit workspace" : "New workspace"}
            title={workspaceEditingId ? "Update saved context" : "Create manually"}
          />
          <WorkspaceForm
            draft={workspaceDraft}
            onChange={setWorkspaceDraft}
            onSave={saveWorkspace}
            onCancel={() => {
              setWorkspaceEditingId(null);
              setWorkspaceDraft(emptyWorkspace(context));
            }}
            editing={!!workspaceEditingId}
          />
        </SectionPanel>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_520px]">
        <SectionPanel>
          <PanelHeading
            eyebrow="Runbooks"
            title="Structured local procedures"
            icon={<ListChecks className="size-3.5" />}
            meta={`${runbooks.length} saved`}
          />
          {runbooks.length === 0 ? (
            <EmptyState text="No runbooks yet. Create one with ordered safe steps." />
          ) : (
            <div className="space-y-2">
              {runbooks.map((runbook) => (
                <div
                  key={runbook.id}
                  className="rounded-control border border-border-subtle bg-elevated p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-[13px] font-semibold text-text-primary">
                        {runbook.name}
                      </h3>
                      <p className="mt-1 text-[12px] text-text-secondary">
                        {runbook.description || "No description."}
                      </p>
                      <p className="mt-1 text-[11px] text-text-muted">
                        {runbook.steps.length} step
                        {runbook.steps.length === 1 ? "" : "s"} · updated{" "}
                        {formatDate(runbook.updatedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => startRunbook(runbook.id)}
                      >
                        run
                      </Button>
                      <IconButton
                        label="edit runbook"
                        onClick={() => editRunbook(runbook)}
                        icon={<Edit3 className="size-3.5" />}
                      />
                      <IconButton
                        label="delete runbook"
                        onClick={() => deleteRunbook(runbook.id)}
                        icon={<Trash2 className="size-3.5" />}
                        danger
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionPanel>

        <div className="space-y-4">
          {activeRunbook && activeRun && (
            <SectionPanel>
              <PanelHeading
                eyebrow="Run in progress"
                title={activeRunbook.name}
                meta={`${activeRun.completedStepIds.length}/${activeRunbook.steps.length} done`}
              />
              <div className="space-y-2">
                {activeRunbook.steps.map((step, index) => {
                  const done = activeRun.completedStepIds.includes(step.id);
                  const current = activeRun.currentStepId === step.id;
                  return (
                    <div
                      key={step.id}
                      className={cn(
                        "rounded-control border p-2.5",
                        current
                          ? "border-accent-primary/50 bg-accent-primary-soft"
                          : "border-border-subtle bg-elevated",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[12px] font-medium text-text-primary">
                            {index + 1}. {step.title}
                          </p>
                          <p className="mt-1 text-[11px] text-text-secondary">
                            {stepSummary(step)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {buildRunbookStepUrl(step, context) && (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => runStep(step)}
                            >
                              open
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant={done ? "secondary" : "default"}
                            size="sm"
                            onClick={() => completeStep(step.id)}
                          >
                            {done ? <Check className="size-3.5" /> : null}
                            {done ? "done" : "complete"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-3"
                onClick={resetRun}
              >
                reset run
              </Button>
            </SectionPanel>
          )}

          <SectionPanel>
            <PanelHeading
              eyebrow={runbookEditingId ? "Edit runbook" : "New runbook"}
              title={runbookEditingId ? "Update procedure" : "Create procedure"}
            />
            <RunbookForm
              draft={runbookDraft}
              onChange={setRunbookDraft}
              onSave={saveRunbook}
              onCancel={() => {
                setRunbookEditingId(null);
                setRunbookDraft(emptyRunbook());
              }}
              editing={!!runbookEditingId}
            />
          </SectionPanel>
        </div>
      </div>
    </LumenPage>
  );
}

function WorkspaceForm({
  draft,
  onChange,
  onSave,
  onCancel,
  editing,
}: {
  draft: WorkspaceInput;
  onChange: (next: WorkspaceInput) => void;
  onSave: () => void;
  onCancel: () => void;
  editing: boolean;
}) {
  return (
    <div className="space-y-3">
      <TextField
        label="name"
        value={draft.name}
        onChange={(name) => onChange({ ...draft, name })}
      />
      <TextField
        label="cluster context"
        value={draft.context}
        onChange={(context) => onChange({ ...draft, context })}
      />
      <TextField
        label="namespace"
        value={draft.namespace ?? ""}
        onChange={(namespace) => onChange({ ...draft, namespace })}
      />
      <TextField
        label="route"
        value={draft.route ?? ""}
        onChange={(route) => onChange({ ...draft, route })}
      />
      <TextField
        label="search"
        value={draft.search ?? ""}
        onChange={(search) => onChange({ ...draft, search })}
      />
      <label className="block text-[11px] font-medium uppercase tracking-wide text-text-muted">
        Notes
        <textarea
          value={draft.notes ?? ""}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
          rows={4}
          className="mt-1 w-full rounded-control border border-border-default bg-elevated px-3 py-2 text-[12px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
        />
      </label>
      <div className="flex items-center justify-end gap-2">
        {editing && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            cancel
          </Button>
        )}
        <Button type="button" onClick={onSave}>
          <Save className="size-3.5" />
          {editing ? "update" : "save"}
        </Button>
      </div>
    </div>
  );
}

function RunbookForm({
  draft,
  onChange,
  onSave,
  onCancel,
  editing,
}: {
  draft: RunbookInput;
  onChange: (next: RunbookInput) => void;
  onSave: () => void;
  onCancel: () => void;
  editing: boolean;
}) {
  function updateStep(index: number, step: RunbookStep) {
    const steps = draft.steps.slice();
    steps[index] = step;
    onChange({ ...draft, steps });
  }

  function changeStepKind(index: number, kind: RunbookStepKind) {
    updateStep(index, {
      ...defaultStep(kind),
      id: draft.steps[index].id,
      title: draft.steps[index].title || defaultStep(kind).title,
    });
  }

  return (
    <div className="space-y-3">
      <TextField
        label="name"
        value={draft.name}
        onChange={(name) => onChange({ ...draft, name })}
      />
      <TextField
        label="description"
        value={draft.description ?? ""}
        onChange={(description) => onChange({ ...draft, description })}
      />
      <div className="space-y-2">
        {draft.steps.map((step, index) => (
          <div
            key={step.id}
            className="rounded-control border border-border-subtle bg-elevated p-2.5"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                Step {index + 1}
              </span>
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...draft,
                    steps: draft.steps.filter((_, i) => i !== index),
                  })
                }
                className="text-text-muted hover:text-danger"
                title="remove step"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <TextField
                label="title"
                value={step.title}
                onChange={(title) => updateStep(index, { ...step, title })}
              />
              <label className="block text-[11px] font-medium uppercase tracking-wide text-text-muted">
                Type
                <select
                  value={step.kind}
                  onChange={(e) =>
                    changeStepKind(index, e.target.value as RunbookStepKind)
                  }
                  className="mt-1 h-9 w-full rounded-control border border-border-default bg-elevated px-3 py-2 text-xs text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
                >
                  {STEP_KINDS.map((kind) => (
                    <option key={kind.value} value={kind.value}>
                      {kind.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <StepFields
              step={step}
              onChange={(next) => updateStep(index, next)}
            />
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => onChange({ ...draft, steps: [...draft.steps, defaultStep()] })}
      >
        <Plus className="size-3.5" />
        add step
      </Button>
      <div className="flex items-center justify-end gap-2">
        {editing && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            cancel
          </Button>
        )}
        <Button type="button" onClick={onSave}>
          <Save className="size-3.5" />
          {editing ? "update" : "save"}
        </Button>
      </div>
    </div>
  );
}

function StepFields({
  step,
  onChange,
}: {
  step: RunbookStep;
  onChange: (next: RunbookStep) => void;
}) {
  if (step.kind === "open-route") {
    return (
      <TextField
        label="route"
        value={step.route ?? ""}
        onChange={(route) => onChange({ ...step, route })}
        className="mt-2"
      />
    );
  }
  if (step.kind === "open-resource") {
    const resource = step.resource ?? { kind: "", namespace: "", name: "" };
    return (
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <TextField
          label="kind"
          value={resource.kind}
          onChange={(kind) => onChange({ ...step, resource: { ...resource, kind } })}
        />
        <TextField
          label="namespace"
          value={resource.namespace}
          onChange={(namespace) =>
            onChange({ ...step, resource: { ...resource, namespace } })
          }
        />
        <TextField
          label="name"
          value={resource.name}
          onChange={(name) => onChange({ ...step, resource: { ...resource, name } })}
        />
      </div>
    );
  }
  if (step.kind === "open-logs") {
    const logs = step.logs ?? { kind: "", namespace: "", name: "", filter: "" };
    return (
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <TextField
          label="namespace"
          value={logs.namespace}
          onChange={(namespace) => onChange({ ...step, logs: { ...logs, namespace } })}
        />
        <TextField
          label="kind"
          value={logs.kind}
          onChange={(kind) => onChange({ ...step, logs: { ...logs, kind } })}
        />
        <TextField
          label="name"
          value={logs.name}
          onChange={(name) => onChange({ ...step, logs: { ...logs, name } })}
        />
        <TextField
          label="grep"
          value={logs.filter ?? ""}
          onChange={(filter) => onChange({ ...step, logs: { ...logs, filter } })}
        />
      </div>
    );
  }
  if (step.kind === "ask-ai") {
    return (
      <TextAreaField
        label="prompt"
        value={step.prompt ?? ""}
        onChange={(prompt) => onChange({ ...step, prompt })}
      />
    );
  }
  return (
    <TextAreaField
      label={step.kind === "port-forward" ? "prompt" : "note"}
      value={step.note ?? ""}
      onChange={(note) => onChange({ ...step, note })}
    />
  );
}

function TextField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "block text-[11px] font-medium uppercase tracking-wide text-text-muted",
        className,
      )}
    >
      {label}
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1"
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="mt-2 block text-[11px] font-medium uppercase tracking-wide text-text-muted">
      {label}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="mt-1 w-full rounded-control border border-border-default bg-surface px-3 py-2 text-[12px] text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
      />
    </label>
  );
}

function IconButton({
  label,
  onClick,
  icon,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  icon: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-control border border-border-default bg-surface text-text-muted hover:bg-hover hover:text-text-primary",
        danger && "hover:border-danger/40 hover:text-danger",
      )}
    >
      {icon}
    </button>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-control border border-dashed border-border-default bg-elevated/60 p-6 text-center text-[12px] text-text-secondary">
      {text}
    </div>
  );
}

function stepSummary(step: RunbookStep): string {
  if (step.kind === "open-route") return step.route ?? "open route";
  if (step.kind === "open-resource" && step.resource) {
    return `${step.resource.kind}/${step.resource.namespace}/${step.resource.name}`;
  }
  if (step.kind === "open-logs" && step.logs) {
    return `logs ${step.logs.kind}/${step.logs.namespace}/${step.logs.name}`;
  }
  if (step.kind === "ask-ai") return step.prompt ?? "ask AI";
  return step.note ?? step.kind;
}

function formatDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "unknown";
  return new Date(ms).toLocaleString();
}
