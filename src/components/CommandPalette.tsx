import { useMemo, useState } from "react";
import type { ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useClusterStore } from "@/state/cluster";
import { useUi } from "@/state/ui";
import { fuzzyRank } from "@/lib/fuzzy";
import { k8s, type WorkloadKind } from "@/lib/k8s";
import {
  listResourceDefinitions,
  resourceKindToSlug,
} from "@/lib/k8s/resourceRegistry";
import {
  Boxes,
  BookOpenCheck,
  FileText,
  Laptop,
  Lock,
  LockOpen,
  Settings as SettingsIcon,
  Layers,
  Moon,
  Network,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
  Sun,
  Terminal,
  UserPlus,
  Workflow,
} from "lucide-react";
import { useThemeStore, type ThemeMode } from "@/state/theme";
import { useUiSettings } from "@/state/uiSettings";
import { useShortcut } from "@/lib/shortcuts";

export const COMMAND_PALETTE_RESOURCE_KINDS: WorkloadKind[] =
  listResourceDefinitions().map((definition) => definition.kind);

type Jumpable = { kind: WorkloadKind; name: string; namespace: string };

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useUi();
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const {
    contextName: currentCtx,
    namespace: currentNs,
    setContext,
    setNamespace,
  } = useClusterStore();
  const normalizedQuery = q
    .replace(/^ns\s+/i, "switch namespace: ")
    .replace(/^ctx\s+/i, "switch context: ")
    .replace(/^logs\s+/i, "view logs: ")
    .replace(/^ai$/i, "go: AI assistant")
    .replace(/^ask$/i, "go: AI assistant")
    .replace(/^assistant$/i, "go: AI assistant");
  const shouldSearchResources = normalizedQuery.trim().length >= 2;

  const { data: contexts = [] } = useQuery({
    queryKey: ["k8s", "contexts"],
    queryFn: k8s.listContexts,
    enabled: paletteOpen,
    staleTime: 30_000,
  });
  const { data: namespaces = [] } = useQuery({
    queryKey: ["k8s", "namespaces", currentCtx],
    queryFn: () => k8s.listNamespaces(),
    enabled: paletteOpen && !!currentCtx,
    staleTime: 30_000,
  });
  // Global search: resource queries fire whenever a context is selected,
  // not just when a namespace is. Backend `list_workloads` treats an empty
  // namespace as "all namespaces" via Api::all_with, so the same code path
  // serves both cases. This is the load-bearing change for global cross-
  // resource search — without it the palette only ever sees the active
  // namespace's pods/deployments/etc.
  const searchScope = currentNs ?? "";
  const resourceQueries = useQueries({
    queries: COMMAND_PALETTE_RESOURCE_KINDS.map((kind) => ({
      queryKey: ["k8s", "workloads", currentCtx, searchScope, kind] as const,
      queryFn: () =>
        k8s.listWorkloads(searchScope, kind, currentCtx ?? undefined),
      enabled: paletteOpen && !!currentCtx && shouldSearchResources,
      staleTime: 10_000,
    })),
  });

  const deployments = resourceQueries[1].data ?? [];
  const allResources: Jumpable[] = useMemo(() => {
    const out: Jumpable[] = [];
    resourceQueries.forEach((query, i) => {
      const kind = COMMAND_PALETTE_RESOURCE_KINDS[i];
      for (const workload of query.data ?? []) {
        out.push({
          kind,
          name: workload.name,
          namespace: workload.namespace,
        });
      }
    });
    return out;
  }, [resourceQueries]);

  const ranked = useMemo(() => {
    const ctxLabels = contexts.map((c) => `switch context: ${c.name}`);
    const nsLabels = namespaces.map((n) => `switch namespace: ${n}`);
    const depLabels = deployments.map((d) => `view logs: ${d.name}`);
    const resourceLabels = allResources.map((r) => `${r.kind}: ${r.name}`);

    return {
      contexts: fuzzyRank(normalizedQuery, ctxLabels)
        .slice(0, 15)
        .map((label) => contexts.find((c) => `switch context: ${c.name}` === label))
        .filter(present),
      namespaces: fuzzyRank(normalizedQuery, nsLabels)
        .slice(0, 15)
        .map((label) => namespaces.find((n) => `switch namespace: ${n}` === label))
        .filter(present),
      deployments: fuzzyRank(normalizedQuery, depLabels)
        .slice(0, 15)
        .map((label) => deployments.find((d) => `view logs: ${d.name}` === label))
        .filter(present),
      // Global search hits N kinds × M namespaces — bumped from 25 to 50 so
      // the top results aren't dominated by one chatty kind (events, pods).
      resources: fuzzyRank(normalizedQuery, resourceLabels)
        .slice(0, 50)
        .map((label) =>
          allResources.find((r) => `${r.kind}: ${r.name}` === label),
        )
        .filter(present),
    };
  }, [normalizedQuery, contexts, namespaces, deployments, allResources]);

  // Cmd+K (or whatever the user remapped openPalette to via Settings).
  useShortcut("openPalette", () => setPaletteOpen(!paletteOpen));

  function close() {
    setPaletteOpen(false);
    setQ("");
  }

  async function pickContext(name: string) {
    try {
      await k8s.setContext(name);
      setContext(name);
      qc.invalidateQueries({ queryKey: ["k8s", "namespaces"] });
      navigate(`/cluster/${encodeURIComponent(name)}/map`);
    } finally {
      close();
    }
  }

  function pickTab(tab: string) {
    const ctx = useClusterStore.getState().contextName;
    if (!ctx) return close();
    navigate(`/cluster/${encodeURIComponent(ctx)}/${tab}`);
    close();
  }

  function pickFleet() {
    navigate("/cluster");
    close();
  }

  function pickTheme(mode: ThemeMode) {
    useThemeStore.getState().setMode(mode);
    close();
  }

  function pickReadOnly(next: boolean) {
    useUiSettings.getState().setReadOnly(next);
    close();
  }

  function pickNamespace(ns: string) {
    setNamespace(ns);
    close();
  }

  function pickResource(resource: Jumpable) {
    const ctx = useClusterStore.getState().contextName;
    if (!ctx) return close();
    const slug = resourceKindToSlug(resource.kind);
    const params = new URLSearchParams({
      q: resource.name,
      ns: resource.namespace,
    });
    navigate(
      `/cluster/${encodeURIComponent(ctx)}/workloads/${slug}?${params.toString()}`,
    );
    close();
  }

  function pickLogs(deploymentName: string) {
    if (!currentNs) return close();
    const ctx = useClusterStore.getState().contextName;
    if (!ctx) return close();
    const params = new URLSearchParams({
      ns: currentNs,
      kind: "deployment",
      name: deploymentName,
    });
    navigate(`/cluster/${encodeURIComponent(ctx)}/logs?${params.toString()}`);
    close();
  }

  const hasResults =
    ranked.contexts.length ||
    ranked.namespaces.length ||
    ranked.deployments.length ||
    ranked.resources.length;

  return (
    <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      <DialogContent className="p-0 max-w-xl overflow-hidden rounded-[8px] bg-term-panel border-term-border text-term-fg shadow-[var(--mds-shadow-whisper)]">
        <Command
          shouldFilter={false}
          className="bg-transparent [&_[cmdk-input-wrapper]]:border-term-border [&_[cmdk-input-wrapper]]:border-b"
        >
          <div className="flex items-center gap-2 border-b border-term-border px-4">
            <Search className="size-4 text-term-muted" aria-hidden="true" />
            <CommandInput
              placeholder={
                currentNs
                  ? `search ${currentNs} · resource, ns, logs, AI, command...`
                  : "search all namespaces · resource, ns, logs, AI, command..."
              }
              value={q}
              onValueChange={setQ}
              className="bg-transparent text-[14px] placeholder:text-term-subtle border-0"
            />
            <kbd className="rounded-[5px] border border-term-border px-1.5 py-0.5 text-[11px] text-term-muted">
              Cmd K
            </kbd>
          </div>
          <CommandList className="max-h-[360px]">
            <CommandGroup
              heading="navigate"
              className="[&_[cmdk-group-heading]]:mds-label [&_[cmdk-group-heading]]:text-term-muted [&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:pt-3"
            >
              <CommandItem value="go: fleet" onSelect={pickFleet} className={itemClass}>
                <Boxes className="mr-2 size-3.5 text-term-muted" />
                go: fleet
              </CommandItem>
              {currentCtx && (
                <>
                  <NavItem value="go: cloudmap" icon={Network} onSelect={() => pickTab("map")} />
                  <NavItem value="go: nodes" icon={Server} onSelect={() => pickTab("nodes")} />
                  <NavItem value="go: security" icon={ShieldAlert} onSelect={() => pickTab("security")} />
                  <NavItem value="go: crds" icon={Boxes} onSelect={() => pickTab("crds")} />
                  <NavItem value="go: helm" icon={Boxes} onSelect={() => pickTab("helm")} />
                  <NavItem value="go: access" icon={UserPlus} onSelect={() => pickTab("access")} />
                  <NavItem value="go: logs" icon={Terminal} onSelect={() => pickTab("logs")} />
                  <NavItem value="go: AI assistant" icon={Sparkles} onSelect={() => pickTab("ai")} />
                  <NavItem value="go: workspaces" icon={BookOpenCheck} onSelect={() => pickTab("workspaces")} />
                  <NavItem value="go: argocd" icon={Layers} onSelect={() => pickTab("argocd")} />
                  <NavItem value="go: tekton pipelines" icon={Workflow} onSelect={() => pickTab("tekton")} />
                  <NavItem
                    value="new: NetworkPolicy"
                    icon={Network}
                    onSelect={() => {
                      const ctxName =
                        useClusterStore.getState().contextName;
                      if (!ctxName) return;
                      navigate(
                        `/cluster/${encodeURIComponent(ctxName)}/wizards/network-policy`,
                      );
                      close();
                    }}
                  />
                  <NavItem
                    value="new: RBAC binding"
                    icon={UserPlus}
                    onSelect={() => {
                      const ctxName =
                        useClusterStore.getState().contextName;
                      if (!ctxName) return;
                      navigate(
                        `/cluster/${encodeURIComponent(ctxName)}/wizards/rbac-binding`,
                      );
                      close();
                    }}
                  />
                  <NavItem
                    value="new: helm release"
                    icon={Boxes}
                    onSelect={() => {
                      const ctxName =
                        useClusterStore.getState().contextName;
                      if (!ctxName) return;
                      navigate(
                        `/cluster/${encodeURIComponent(ctxName)}/helm/install`,
                      );
                      close();
                    }}
                  />
                </>
              )}
              <NavItem value="theme: light" icon={Sun} onSelect={() => pickTheme("light")} />
              <NavItem value="theme: dark" icon={Moon} onSelect={() => pickTheme("dark")} />
              <NavItem value="theme: system" icon={Laptop} onSelect={() => pickTheme("system")} />
              <NavItem value="read-only: on" icon={Lock} onSelect={() => pickReadOnly(true)} />
              <NavItem value="read-only: off" icon={LockOpen} onSelect={() => pickReadOnly(false)} />
              <NavItem
                value="go: settings"
                icon={SettingsIcon}
                onSelect={() => {
                  navigate("/settings");
                  close();
                }}
              />
            </CommandGroup>
            {ranked.contexts.length > 0 && (
              <CommandGroup heading={`contexts · ${ranked.contexts.length}`} className={groupClass}>
                {ranked.contexts.map((ctx) => (
                  <CommandItem
                    key={`ctx-${ctx.name}`}
                    value={`switch context: ${ctx.name}`}
                    onSelect={() => pickContext(ctx.name)}
                    className={itemClass}
                  >
                    <Layers className={`mr-2 size-3.5 ${ctx.is_prod ? "text-term-amber" : "text-term-muted"}`} aria-hidden="true" />
                    <span className={ctx.is_prod ? "text-term-amber" : undefined}>switch context: {ctx.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {ranked.namespaces.length > 0 && (
              <CommandGroup heading={`namespaces · ${ranked.namespaces.length}`} className={groupClass}>
                {ranked.namespaces.map((namespace) => (
                  <CommandItem
                    key={`ns-${namespace}`}
                    value={`switch namespace: ${namespace}`}
                    onSelect={() => pickNamespace(namespace)}
                    className={itemClass}
                  >
                    <FileText className="mr-2 size-3.5 text-term-muted" aria-hidden="true" />
                    switch namespace: {namespace}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {ranked.resources.length > 0 && (
              <CommandGroup heading={`resources · ${ranked.resources.length}`} className={groupClass}>
                {ranked.resources.map((resource) => (
                  <CommandItem
                    key={`res-${resource.kind}-${resource.namespace}-${resource.name}`}
                    value={`${resource.kind}: ${resource.name}`}
                    onSelect={() => pickResource(resource)}
                    className={itemClass}
                  >
                    <Boxes className="mr-2 size-3.5 text-term-muted" aria-hidden="true" />
                    <span className="mr-2 font-mono text-[11px] text-term-subtle">
                      {resource.kind}
                    </span>
                    {resource.name}
                    <span className="ml-auto font-mono text-[11px] text-term-subtle">
                      {resource.namespace}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {ranked.deployments.length > 0 && (
              <CommandGroup heading={`logs · ${ranked.deployments.length}`} className={groupClass}>
                {ranked.deployments.map((deployment) => (
                  <CommandItem
                    key={`logs-${deployment.name}`}
                    value={`view logs: ${deployment.name}`}
                    onSelect={() => pickLogs(deployment.name)}
                    className={itemClass}
                  >
                    <Terminal className="mr-2 size-3.5 text-term-muted" aria-hidden="true" />
                    view logs: {deployment.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {!hasResults && (
              <CommandEmpty className="py-8 text-center text-[13px] text-term-subtle">
                no results.
              </CommandEmpty>
            )}
          </CommandList>
          <div className="flex items-center justify-between border-t border-term-border px-4 py-2 text-[11px] text-term-subtle">
            <div className="flex gap-3">
              <span>up/down navigate</span>
              <span>enter open</span>
              <span>esc close</span>
            </div>
            <span>fuzzy match</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

const itemClass =
  "text-[14px] text-term-fg aria-selected:bg-term-green/10 aria-selected:text-term-green";
const groupClass =
  "[&_[cmdk-group-heading]]:mds-label [&_[cmdk-group-heading]]:text-term-muted [&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:pt-2";

function NavItem({
  value,
  icon: Icon,
  onSelect,
}: {
  value: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={value} onSelect={onSelect} className={itemClass}>
      <Icon className="mr-2 size-3.5 text-term-muted" aria-hidden />
      {value}
    </CommandItem>
  );
}
