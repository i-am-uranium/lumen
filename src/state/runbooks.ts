import { create } from "zustand";

export const RUNBOOKS_STORAGE_KEY = "lumen:runbooks";

export type RunbookResourceTarget = {
  kind: string;
  namespace: string;
  name: string;
};

export type RunbookLogsTarget = {
  namespace: string;
  kind: string;
  name: string;
  container?: string | null;
  filter?: string;
};

export type RunbookStepKind =
  | "open-route"
  | "open-resource"
  | "open-logs"
  | "port-forward"
  | "ask-ai"
  | "checklist";

export type RunbookStep = {
  id: string;
  kind: RunbookStepKind;
  title: string;
  route?: string;
  resource?: RunbookResourceTarget;
  logs?: RunbookLogsTarget;
  prompt?: string;
  note?: string;
};

export type RunbookInput = {
  name: string;
  description?: string;
  steps: RunbookStep[];
};

export type SavedRunbook = RunbookInput & {
  id: string;
  createdAt: number;
  updatedAt: number;
};

export type ActiveRunbookRun = {
  runbookId: string;
  currentStepId: string | null;
  completedStepIds: string[];
};

type Store = {
  runbooks: SavedRunbook[];
  activeRun: ActiveRunbookRun | null;
  addRunbook: (input: RunbookInput, now?: number) => SavedRunbook;
  updateRunbook: (
    id: string,
    patch: Partial<RunbookInput>,
    now?: number,
  ) => SavedRunbook | null;
  deleteRunbook: (id: string) => void;
  startRunbook: (id: string) => void;
  completeStep: (stepId: string) => void;
  setCurrentStep: (stepId: string) => void;
  resetRun: () => void;
  reset: () => void;
};

function nowMs(): number {
  return Date.now();
}

function makeId(prefix: string, now: number): string {
  return `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clean(input: RunbookInput): RunbookInput {
  return {
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    steps: input.steps.map(cleanStep),
  };
}

function cleanStep(step: RunbookStep): RunbookStep {
  return {
    id: step.id?.trim() || makeId("step", nowMs()),
    kind: step.kind,
    title: step.title.trim(),
    route: step.route?.trim(),
    resource: step.resource
      ? {
          kind: step.resource.kind.trim(),
          namespace: step.resource.namespace.trim(),
          name: step.resource.name.trim(),
        }
      : undefined,
    logs: step.logs
      ? {
          namespace: step.logs.namespace.trim(),
          kind: step.logs.kind.trim(),
          name: step.logs.name.trim(),
          container: step.logs.container?.trim() || null,
          filter: step.logs.filter?.trim() ?? "",
        }
      : undefined,
    prompt: step.prompt?.trim(),
    note: step.note?.trim(),
  };
}

function writePersisted(runbooks: SavedRunbook[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RUNBOOKS_STORAGE_KEY, JSON.stringify(runbooks));
  } catch {
    // Best-effort local preference persistence.
  }
}

function readPersisted(): SavedRunbook[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RUNBOOKS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SavedRunbook[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<SavedRunbook>;
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.name !== "string" ||
        !Array.isArray(candidate.steps)
      ) {
        return [];
      }
      const cleaned = clean({
        name: candidate.name,
        description: candidate.description,
        steps: candidate.steps,
      });
      if (validateRunbookInput(cleaned).length > 0) return [];
      return [
        {
          ...cleaned,
          id: candidate.id,
          createdAt:
            typeof candidate.createdAt === "number" ? candidate.createdAt : 0,
          updatedAt:
            typeof candidate.updatedAt === "number" ? candidate.updatedAt : 0,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function validateRunbookInput(input: RunbookInput): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push("Name is required.");
  if (input.steps.length === 0) errors.push("At least one step is required.");

  input.steps.forEach((step, index) => {
    const label = `Step ${index + 1}`;
    if (!step.title.trim()) errors.push(`${label} needs a title.`);
    if (step.kind === "open-route" && !step.route?.trim()) {
      errors.push(`${label} needs a route.`);
    }
    if (
      step.kind === "open-route" &&
      step.route &&
      (step.route.includes("://") || step.route.startsWith("//"))
    ) {
      errors.push(`${label} route must stay inside Lumen.`);
    }
    if (step.kind === "open-resource" && !step.resource) {
      errors.push(`${label} needs a resource target.`);
    }
    if (step.kind === "open-logs" && !step.logs) {
      errors.push(`${label} needs a logs target.`);
    }
    if (step.kind === "ask-ai" && !step.prompt?.trim()) {
      errors.push(`${label} needs an AI prompt.`);
    }
    if (
      (step.kind === "checklist" || step.kind === "port-forward") &&
      !step.note?.trim()
    ) {
      errors.push(`${label} needs instructions.`);
    }
  });

  return errors;
}

function resourceKindToSlug(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  const explicit: Record<string, string> = {
    pod: "pods",
    deployment: "deployments",
    statefulset: "statefulsets",
    daemonset: "daemonsets",
    replicaset: "replicasets",
    replicationcontroller: "replicationcontrollers",
    job: "jobs",
    cronjob: "cronjobs",
    configmap: "configmaps",
    secret: "secrets",
    service: "services",
    ingress: "ingresses",
    networkpolicy: "networkpolicies",
    persistentvolumeclaim: "pvcs",
    persistentvolume: "pvs",
    serviceaccount: "serviceaccounts",
    role: "roles",
    rolebinding: "rolebindings",
    clusterrole: "clusterroles",
    clusterrolebinding: "clusterrolebindings",
    node: "nodes",
    namespace: "namespaces",
  };
  return explicit[normalized] ?? `${normalized}s`;
}

function normalizeRoute(route: string): { child: string; params: URLSearchParams } {
  const [pathRaw, queryRaw = ""] = route.trim().split("?");
  const params = new URLSearchParams(queryRaw);
  if (!pathRaw || pathRaw === "/") return { child: "workloads", params };
  if (pathRaw.startsWith("/cluster/")) {
    const parts = pathRaw.split("/").filter(Boolean);
    return { child: parts.slice(2).join("/") || "workloads", params };
  }
  if (pathRaw.startsWith("/")) return { child: pathRaw.slice(1), params };
  return { child: pathRaw, params };
}

export function buildRunbookStepUrl(
  step: RunbookStep,
  context: string,
): string | null {
  const base = `/cluster/${encodeURIComponent(context)}`;

  if (step.kind === "open-route" && step.route) {
    const { child, params } = normalizeRoute(step.route);
    const qs = params.toString();
    return `${base}/${child}${qs ? `?${qs}` : ""}`;
  }

  if (step.kind === "open-resource" && step.resource) {
    const params = new URLSearchParams({
      ns: step.resource.namespace,
      q: step.resource.name,
    });
    return `${base}/workloads/${resourceKindToSlug(step.resource.kind)}?${params.toString()}`;
  }

  if (step.kind === "open-logs" && step.logs) {
    const params = new URLSearchParams({
      ns: step.logs.namespace,
      kind: step.logs.kind,
      name: step.logs.name,
    });
    if (step.logs.container) params.set("c", step.logs.container);
    if (step.logs.filter) params.set("grep", step.logs.filter);
    return `${base}/logs?${params.toString()}`;
  }

  if (step.kind === "ask-ai" && step.prompt) {
    const params = new URLSearchParams({
      task: "root-cause",
      question: step.prompt,
    });
    return `${base}/ai?${params.toString()}`;
  }

  return null;
}

export const useRunbooksStore = create<Store>((set, get) => ({
  runbooks: readPersisted(),
  activeRun: null,
  addRunbook: (input, now = nowMs()) => {
    const cleaned = clean(input);
    const errors = validateRunbookInput(cleaned);
    if (errors.length > 0) throw new Error(errors.join(" "));
    const runbook: SavedRunbook = {
      ...cleaned,
      id: makeId("runbook", now),
      createdAt: now,
      updatedAt: now,
    };
    const next = [runbook, ...get().runbooks];
    writePersisted(next);
    set({ runbooks: next });
    return runbook;
  },
  updateRunbook: (id, patch, now = nowMs()) => {
    let updated: SavedRunbook | null = null;
    const next = get().runbooks.map((runbook) => {
      if (runbook.id !== id) return runbook;
      const cleaned = clean({ ...runbook, ...patch });
      const errors = validateRunbookInput(cleaned);
      if (errors.length > 0) throw new Error(errors.join(" "));
      updated = { ...runbook, ...cleaned, updatedAt: now };
      return updated;
    });
    if (!updated) return null;
    writePersisted(next);
    set({ runbooks: next });
    return updated;
  },
  deleteRunbook: (id) => {
    const next = get().runbooks.filter((runbook) => runbook.id !== id);
    writePersisted(next);
    set((state) => ({
      runbooks: next,
      activeRun:
        state.activeRun?.runbookId === id ? null : state.activeRun,
    }));
  },
  startRunbook: (id) => {
    const runbook = get().runbooks.find((item) => item.id === id);
    if (!runbook) return;
    set({
      activeRun: {
        runbookId: id,
        currentStepId: runbook.steps[0]?.id ?? null,
        completedStepIds: [],
      },
    });
  },
  completeStep: (stepId) => {
    const active = get().activeRun;
    if (!active) return;
    const runbook = get().runbooks.find((item) => item.id === active.runbookId);
    if (!runbook) return;
    const completed = active.completedStepIds.includes(stepId)
      ? active.completedStepIds
      : [...active.completedStepIds, stepId];
    const currentIndex = runbook.steps.findIndex((step) => step.id === stepId);
    const nextStep = runbook.steps
      .slice(currentIndex + 1)
      .find((step) => !completed.includes(step.id));
    set({
      activeRun: {
        ...active,
        completedStepIds: completed,
        currentStepId: nextStep?.id ?? null,
      },
    });
  },
  setCurrentStep: (stepId) => {
    const active = get().activeRun;
    if (!active) return;
    set({ activeRun: { ...active, currentStepId: stepId } });
  },
  resetRun: () => set({ activeRun: null }),
  reset: () => {
    writePersisted([]);
    set({ runbooks: [], activeRun: null });
  },
}));
