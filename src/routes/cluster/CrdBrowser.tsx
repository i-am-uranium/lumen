import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Boxes,
  ChevronRight,
  Copy,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { k8s, type CrInstance, type CrdSummary } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export function CrdBrowser() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["k8s", "crds", context],
    queryFn: () => k8s.listCrds(context || undefined),
    staleTime: 60_000,
  });

  const [selected, setSelected] = useState<CrdSummary | null>(null);
  const [query, setQuery] = useState("");
  const [yamlOpen, setYamlOpen] = useState<{
    instance: CrInstance;
    crd: CrdSummary;
  } | null>(null);

  const grouped = useMemo(() => {
    const all = data ?? [];
    const q = query.trim().toLowerCase();
    const matches = (c: CrdSummary) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      c.group.toLowerCase().includes(q) ||
      c.kind.toLowerCase().includes(q) ||
      c.short_names.some((s) => s.toLowerCase().includes(q));
    const groups = new Map<string, CrdSummary[]>();
    for (const c of all.filter(matches)) {
      const key = c.group || "(core)";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [data, query]);

  return (
    <div className="flex h-full">
      <aside className="w-[340px] border-r border-term-border-soft bg-term-panel flex flex-col min-h-0">
        <div className="flex items-center justify-between px-4 h-12 border-b border-term-border-soft shrink-0">
          <h2 className="mds-heading text-[14px] text-term-fg flex items-center gap-2">
            <Boxes className="size-4" /> CRDs
            <span className="text-[11px] text-term-subtle font-normal">
              {data?.length ?? 0}
            </span>
          </h2>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-term-muted hover:text-term-fg"
          >
            <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
          </button>
        </div>
        <div className="p-2 border-b border-term-border-soft">
          <div className="flex items-center gap-2 h-8 px-2 rounded-md bg-term-bg border border-term-border-soft">
            <Search className="size-3.5 text-term-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by name, group, or kind..."
              className="flex-1 bg-transparent outline-none text-[12px] text-term-fg placeholder:text-term-subtle"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {error ? (
            <div className="p-3 text-[12px] text-term-red">
              {(error as Error).message}
            </div>
          ) : isLoading ? (
            <div className="p-3 text-[12px] text-term-muted">loading CRDs…</div>
          ) : grouped.length === 0 ? (
            <div className="p-3 text-[12px] text-term-muted">no CRDs match.</div>
          ) : (
            grouped.map(([group, crds]) => (
              <div key={group} className="py-1">
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-term-subtle">
                  {group}
                </div>
                {crds.map((c) => {
                  const active = selected?.name === c.name;
                  return (
                    <button
                      key={c.name}
                      onClick={() => setSelected(c)}
                      className={cn(
                        "w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 hover:bg-term-panel-2 transition-colors",
                        active && "bg-term-green-soft",
                      )}
                    >
                      <span
                        className={cn(
                          "text-term-fg truncate",
                          active && "text-term-green",
                        )}
                      >
                        {c.kind}
                      </span>
                      <span className="text-term-subtle text-[10px] font-mono truncate">
                        {c.plural}
                      </span>
                      <span
                        className={cn(
                          "ml-auto text-[10px] px-1 py-0.5 rounded font-mono",
                          c.scope === "Namespaced"
                            ? "bg-info-soft text-info"
                            : "bg-purple-100 text-purple-800 dark:bg-purple-500/10 dark:text-purple-300",
                        )}
                      >
                        {c.scope[0]}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-hidden">
        {!selected ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-term-muted gap-2">
            <Boxes className="size-6" />
            <p className="text-[13px]">select a CRD to list its instances</p>
          </div>
        ) : (
          <InstanceTable
            context={context}
            crd={selected}
            onInspect={(inst) => setYamlOpen({ instance: inst, crd: selected })}
          />
        )}
      </main>

      {yamlOpen && (
        <YamlModal
          context={context}
          crd={yamlOpen.crd}
          instance={yamlOpen.instance}
          onClose={() => setYamlOpen(null)}
        />
      )}
    </div>
  );
}

function InstanceTable({
  context,
  crd,
  onInspect,
}: {
  context: string;
  crd: CrdSummary;
  onInspect: (i: CrInstance) => void;
}) {
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["k8s", "cr-instances", context, crd.name, crd.preferred_version],
    queryFn: () =>
      k8s.listCrInstances(
        crd.group,
        crd.preferred_version,
        crd.kind,
        crd.plural,
        undefined,
        context || undefined,
      ),
    staleTime: 10_000,
  });

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-5 py-3 border-b border-term-border-soft bg-term-panel">
        <div className="min-w-0">
          <h2 className="mds-heading text-[16px] text-term-fg flex items-center gap-2">
            {crd.kind}
            <span className="text-[11px] text-term-subtle font-mono">
              {crd.group}/{crd.preferred_version}
            </span>
          </h2>
          <p className="text-[11px] text-term-muted">
            {crd.scope} · {crd.plural}
            {crd.short_names.length > 0 &&
              ` · aliases: ${crd.short_names.join(", ")}`}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
        >
          <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-[12px] text-term-red">
            {(error as Error).message}
          </div>
        ) : isLoading ? (
          <div className="p-4 text-[12px] text-term-muted">loading…</div>
        ) : (data ?? []).length === 0 ? (
          <div className="p-6 text-center text-[13px] text-term-muted">
            no instances of <span className="text-term-fg">{crd.kind}</span>.
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-term-panel">
              <tr className="text-term-subtle text-[10px] uppercase tracking-wider">
                <th className="text-left px-4 py-2">name</th>
                {crd.scope === "Namespaced" && (
                  <th className="text-left px-4 py-2">namespace</th>
                )}
                <th className="text-left px-4 py-2">status</th>
                <th className="text-left px-4 py-2">age</th>
                <th className="text-right px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((inst) => (
                <tr
                  key={`${inst.namespace ?? ""}/${inst.name}`}
                  className="border-b border-term-border-soft hover:bg-term-panel-2"
                >
                  <td className="px-4 py-2 text-term-fg font-mono">
                    {inst.name}
                  </td>
                  {crd.scope === "Namespaced" && (
                    <td className="px-4 py-2 text-term-muted font-mono">
                      {inst.namespace ?? "—"}
                    </td>
                  )}
                  <td className="px-4 py-2 text-term-muted font-mono">
                    {inst.status_hint ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-term-muted tabular-nums">
                    {formatAge(inst.age_seconds)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => onInspect(inst)}
                      className="text-term-subtle hover:text-term-green inline-flex items-center gap-1 text-[11px]"
                    >
                      yaml <ChevronRight className="size-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function YamlModal({
  context,
  crd,
  instance,
  onClose,
}: {
  context: string;
  crd: CrdSummary;
  instance: CrInstance;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: [
      "k8s",
      "cr-yaml",
      context,
      crd.name,
      instance.namespace,
      instance.name,
    ],
    queryFn: () =>
      k8s.getCrYaml(
        crd.group,
        crd.preferred_version,
        crd.kind,
        crd.plural,
        instance.name,
        instance.namespace ?? undefined,
        context || undefined,
      ),
  });

  const copy = async () => {
    if (!data) return;
    await navigator.clipboard.writeText(data);
    toast.success("YAML copied");
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-term-panel border border-term-border rounded-lg shadow-2xl max-w-4xl w-full max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-term-border-soft">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[12px] text-term-muted font-mono">
              {crd.kind}
            </span>
            <span className="text-term-subtle">·</span>
            <span className="text-[12px] text-term-fg truncate">
              {instance.namespace ? `${instance.namespace}/` : ""}
              {instance.name}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={copy}
              className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px]"
            >
              <Copy className="size-3" /> copy
            </button>
            <button onClick={onClose} className="text-term-subtle hover:text-term-fg">
              <X className="size-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-0">
          {error ? (
            <pre className="p-4 text-[12px] text-term-red whitespace-pre-wrap">
              {(error as Error).message}
            </pre>
          ) : isLoading ? (
            <div className="p-4 text-[12px] text-term-muted">loading…</div>
          ) : (
            <pre className="p-4 text-[12px] text-term-fg font-mono leading-relaxed whitespace-pre">
              {data}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function formatAge(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
