import { create } from "zustand";

export const WORKSPACES_STORAGE_KEY = "lumen:workspaces";

export type WorkspaceResourceRef = {
  kind: string;
  namespace: string;
  name: string;
};

export type WorkspaceLogQuery = {
  namespace: string;
  kind: string;
  name: string;
  container?: string | null;
  filter?: string;
};

export type WorkspaceInput = {
  name: string;
  context: string;
  namespace?: string;
  route?: string;
  search?: string;
  selectedResource?: WorkspaceResourceRef | null;
  logQuery?: WorkspaceLogQuery | null;
  notes?: string;
};

export type SavedWorkspace = WorkspaceInput & {
  id: string;
  createdAt: number;
  updatedAt: number;
  route: string;
};

type Store = {
  workspaces: SavedWorkspace[];
  addWorkspace: (input: WorkspaceInput, now?: number) => SavedWorkspace;
  updateWorkspace: (
    id: string,
    patch: Partial<WorkspaceInput>,
    now?: number,
  ) => SavedWorkspace | null;
  deleteWorkspace: (id: string) => void;
  reset: () => void;
};

function nowMs(): number {
  return Date.now();
}

function makeId(prefix: string, now: number): string {
  return `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clean(input: WorkspaceInput): WorkspaceInput {
  return {
    name: input.name.trim(),
    context: input.context.trim(),
    namespace: input.namespace?.trim() ?? "",
    route: normalizeInputRoute(input.route),
    search: input.search?.trim() ?? "",
    selectedResource: normalizeResource(input.selectedResource),
    logQuery: normalizeLogQuery(input.logQuery),
    notes: input.notes?.trim() ?? "",
  };
}

function normalizeResource(
  resource: WorkspaceInput["selectedResource"],
): WorkspaceResourceRef | null {
  if (!resource) return null;
  const kind = resource.kind.trim();
  const namespace = resource.namespace.trim();
  const name = resource.name.trim();
  if (!kind || !name) return null;
  return { kind, namespace, name };
}

function normalizeLogQuery(
  query: WorkspaceInput["logQuery"],
): WorkspaceLogQuery | null {
  if (!query) return null;
  const namespace = query.namespace.trim();
  const kind = query.kind.trim();
  const name = query.name.trim();
  if (!namespace || !kind || !name) return null;
  return {
    namespace,
    kind,
    name,
    container: query.container?.trim() || null,
    filter: query.filter?.trim() ?? "",
  };
}

function normalizeInputRoute(route: string | undefined): string {
  const trimmed = route?.trim() ?? "";
  return trimmed || "workloads";
}

function writePersisted(workspaces: SavedWorkspace[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      WORKSPACES_STORAGE_KEY,
      JSON.stringify(workspaces),
    );
  } catch {
    // Best-effort local preference persistence.
  }
}

function readPersisted(): SavedWorkspace[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(WORKSPACES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): SavedWorkspace[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Partial<SavedWorkspace>;
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.name !== "string" ||
        typeof candidate.context !== "string"
      ) {
        return [];
      }
      const cleaned = clean({
        name: candidate.name,
        context: candidate.context,
        namespace: candidate.namespace,
        route: candidate.route,
        search: candidate.search,
        selectedResource: candidate.selectedResource,
        logQuery: candidate.logQuery,
        notes: candidate.notes,
      });
      if (validateWorkspaceInput(cleaned).length > 0) return [];
      return [
        {
          ...cleaned,
          id: candidate.id,
          route: cleaned.route ?? "workloads",
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

export function validateWorkspaceInput(input: WorkspaceInput): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push("Name is required.");
  if (!input.context.trim()) errors.push("Cluster context is required.");
  const route = input.route?.trim() ?? "";
  if (route && (route.includes("://") || route.startsWith("//"))) {
    errors.push("Route must stay inside Lumen.");
  }
  return errors;
}

function clusterChildFromRoute(route: string | undefined): {
  child: string;
  params: URLSearchParams;
} {
  const raw = normalizeInputRoute(route);
  const [pathRaw, queryRaw = ""] = raw.split("?");
  const path = pathRaw.trim();
  const params = new URLSearchParams(queryRaw);
  if (!path || path === "/") return { child: "workloads", params };

  if (path.startsWith("/cluster/")) {
    const parts = path.split("/").filter(Boolean);
    return { child: parts.slice(2).join("/") || "workloads", params };
  }

  if (path === "/cluster") return { child: "workloads", params };
  if (path.startsWith("/")) {
    return { child: path.slice(1) || "workloads", params };
  }
  return { child: path, params };
}

export function buildWorkspaceRestoreUrl(workspace: SavedWorkspace): string {
  const { child, params } = clusterChildFromRoute(workspace.route);
  const clusterBase = `/cluster/${encodeURIComponent(workspace.context)}`;

  if (child === "logs" || child.startsWith("logs/")) {
    const logParams = new URLSearchParams();
    const log = workspace.logQuery;
    if (log) {
      logParams.set("ns", log.namespace);
      logParams.set("kind", log.kind);
      logParams.set("name", log.name);
      if (log.container) logParams.set("c", log.container);
      if (log.filter) logParams.set("grep", log.filter);
    } else if (workspace.namespace) {
      logParams.set("ns", workspace.namespace);
    }
    const qs = logParams.toString();
    return `${clusterBase}/logs${qs ? `?${qs}` : ""}`;
  }

  if (workspace.selectedResource && child.startsWith("workloads")) {
    params.set("ns", workspace.selectedResource.namespace);
    if (!workspace.search) params.set("q", workspace.selectedResource.name);
  } else if (workspace.namespace) {
    params.set("ns", workspace.namespace);
  }
  if (workspace.search) params.set("q", workspace.search);

  const qs = params.toString();
  return `${clusterBase}/${child}${qs ? `?${qs}` : ""}`;
}

export const useWorkspacesStore = create<Store>((set, get) => ({
  workspaces: readPersisted(),
  addWorkspace: (input, now = nowMs()) => {
    const cleaned = clean(input);
    const errors = validateWorkspaceInput(cleaned);
    if (errors.length > 0) throw new Error(errors.join(" "));
    const workspace: SavedWorkspace = {
      ...cleaned,
      id: makeId("ws", now),
      route: cleaned.route ?? "workloads",
      createdAt: now,
      updatedAt: now,
    };
    const next = [workspace, ...get().workspaces];
    writePersisted(next);
    set({ workspaces: next });
    return workspace;
  },
  updateWorkspace: (id, patch, now = nowMs()) => {
    let updated: SavedWorkspace | null = null;
    const next = get().workspaces.map((workspace) => {
      if (workspace.id !== id) return workspace;
      const cleaned = clean({ ...workspace, ...patch });
      const errors = validateWorkspaceInput(cleaned);
      if (errors.length > 0) throw new Error(errors.join(" "));
      updated = {
        ...workspace,
        ...cleaned,
        route: cleaned.route ?? "workloads",
        updatedAt: now,
      };
      return updated;
    });
    if (!updated) return null;
    writePersisted(next);
    set({ workspaces: next });
    return updated;
  },
  deleteWorkspace: (id) => {
    const next = get().workspaces.filter((workspace) => workspace.id !== id);
    writePersisted(next);
    set({ workspaces: next });
  },
  reset: () => {
    writePersisted([]);
    set({ workspaces: [] });
  },
}));
