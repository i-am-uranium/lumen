import { useEffect, useMemo, useState } from "react";
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
  Boxes,
  FileText,
  Layers,
  Network,
  Search,
  Server,
  ShieldAlert,
  Terminal,
  UserPlus,
} from "lucide-react";

const JUMP_KINDS: WorkloadKind[] = [
  "pod",
  "deployment",
  "statefulset",
  "daemonset",
  "service",
  "ingress",
  "configmap",
  "secret",
  "persistentvolumeclaim",
  "horizontalpodautoscaler",
  "networkpolicy",
];

const KIND_TO_SLUG: Record<WorkloadKind, string> = {
  pod: "pods",
  deployment: "deployments",
  statefulset: "statefulsets",
  daemonset: "daemonsets",
  cronjob: "cronjobs",
  job: "jobs",
  service: "services",
  ingress: "ingresses",
  configmap: "configmaps",
  secret: "secrets",
  networkpolicy: "networkpolicies",
  persistentvolumeclaim: "pvcs",
  persistentvolume: "pvs",
  storageclass: "storageclasses",
  ingressclass: "ingressclasses",
  resourcequota: "resourcequotas",
  horizontalpodautoscaler: "hpas",
  limitrange: "limitranges",
  poddisruptionbudget: "pdbs",
  priorityclass: "priorityclasses",
  mutatingwebhookconfiguration: "mutatingwebhooks",
  validatingwebhookconfiguration: "validatingwebhooks",
};

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
    .replace(/^logs\s+/i, "view logs: ");

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
  const resourceQueries = useQueries({
    queries: JUMP_KINDS.map((kind) => ({
      queryKey: ["k8s", "workloads", currentCtx, currentNs, kind] as const,
      queryFn: () =>
        k8s.listWorkloads(currentNs ?? "", kind, currentCtx ?? undefined),
      enabled: paletteOpen && !!currentNs,
      staleTime: 10_000,
    })),
  });

  const deployments = resourceQueries[1].data ?? [];
  const allResources: Jumpable[] = useMemo(() => {
    const out: Jumpable[] = [];
    resourceQueries.forEach((query, i) => {
      const kind = JUMP_KINDS[i];
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
      resources: fuzzyRank(normalizedQuery, resourceLabels)
        .slice(0, 25)
        .map((label) =>
          allResources.find((r) => `${r.kind}: ${r.name}` === label),
        )
        .filter(present),
    };
  }, [normalizedQuery, contexts, namespaces, deployments, allResources]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, setPaletteOpen]);

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

  function pickNamespace(ns: string) {
    setNamespace(ns);
    close();
  }

  function pickResource(resource: Jumpable) {
    const ctx = useClusterStore.getState().contextName;
    if (!ctx) return close();
    const slug = KIND_TO_SLUG[resource.kind] ?? "pods";
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
              placeholder="jump to resource, namespace, logs, or command..."
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
                </>
              )}
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
