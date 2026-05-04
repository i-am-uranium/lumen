import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Boxes,
  CircleDot,
  Cpu,
  Folders,
  MemoryStick,
  Server,
} from "lucide-react";
import { k8s } from "@/lib/k8s";
import { cn } from "@/lib/utils";

function CardShell({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-term-border-soft bg-term-panel p-4">
      <div className="flex items-center gap-1.5 text-term-subtle mb-2">
        <span className="text-term-muted">{icon}</span>
        <span className="text-[11px] uppercase tracking-wider text-term-muted">
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function BigNumber({
  value,
  className,
}: {
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-[26px] leading-none font-semibold text-term-fg tabular-nums",
        className,
      )}
    >
      {value}
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1.5 text-[11px] text-term-muted tabular-nums">
      {children}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-lg border border-term-border-soft bg-term-panel p-4 h-[96px] animate-pulse">
      <div className="h-3 w-16 bg-term-panel-2 rounded mb-3" />
      <div className="h-7 w-20 bg-term-panel-2 rounded" />
      <div className="h-3 w-24 bg-term-panel-2 rounded mt-3" />
    </div>
  );
}

function ErrorBody({ error }: { error: unknown }) {
  return (
    <div className="text-[12px] text-term-red break-words">
      {(error as Error)?.message ?? "failed to load"}
    </div>
  );
}

export function Overview() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);

  const nodesQ = useQuery({
    queryKey: ["k8s", "overview", "nodes", context],
    queryFn: () => k8s.listNodes(context || undefined),
    staleTime: 15_000,
  });

  const namespacesQ = useQuery({
    queryKey: ["k8s", "overview", "namespaces", context],
    queryFn: () => k8s.listNamespaces(context || undefined),
    staleTime: 15_000,
  });

  const fleetQ = useQuery({
    queryKey: ["k8s", "overview", "fleet"],
    queryFn: () => k8s.listFleet(),
    staleTime: 15_000,
  });

  const fleetCard = useMemo(
    () => fleetQ.data?.find((c) => c.context.name === context) ?? null,
    [fleetQ.data, context],
  );

  // Workloads: listWorkloads requires (namespace, kind). To produce a real
  // health breakdown across all namespaces we'd need many parallel calls.
  // For the overview we use the fleet card's workload_count for the total
  // and the namespaces list to iterate deployments only for a quick health
  // breakdown (deployments are the most user-meaningful workload kind).
  const workloadsQ = useQuery({
    queryKey: [
      "k8s",
      "overview",
      "workloads",
      context,
      namespacesQ.data?.length ?? 0,
    ],
    queryFn: async () => {
      const nss = namespacesQ.data ?? [];
      if (nss.length === 0) return [] as { health: string }[];
      const results = await Promise.all(
        nss.map((ns) =>
          k8s
            .listWorkloads(ns, "deployment", context || undefined)
            .catch(() => []),
        ),
      );
      return results.flat();
    },
    enabled: !!namespacesQ.data,
    staleTime: 15_000,
  });

  // Nodes card values
  const nodesReady = (nodesQ.data ?? []).filter((n) => n.ready).length;
  const nodesTotal = nodesQ.data?.length ?? 0;

  // Workloads card values: prefer fleet card total, derive health breakdown
  // from deployments-only summaries.
  const workloadsTotal =
    fleetCard?.workload_count ?? workloadsQ.data?.length ?? 0;
  const wlBreakdown = useMemo(() => {
    const acc = { healthy: 0, degraded: 0, failed: 0 };
    for (const w of workloadsQ.data ?? []) {
      if (w.health === "healthy") acc.healthy++;
      else if (w.health === "degraded") acc.degraded++;
      else if (w.health === "failed") acc.failed++;
    }
    return acc;
  }, [workloadsQ.data]);

  // Pods card values come from fleet card health
  const pods = fleetCard?.health ?? null;

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-term-bg/95 backdrop-blur border-b border-term-border-soft px-6 py-4">
        <h1 className="mds-heading text-[20px] text-term-fg flex items-center gap-2">
          <Activity className="size-5" /> overview
        </h1>
        <p className="text-[12px] text-term-muted">{context}</p>
      </div>

      <div className="p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Nodes */}
          {nodesQ.isLoading ? (
            <SkeletonCard />
          ) : (
            <CardShell icon={<Server className="size-3.5" />} label="nodes">
              {nodesQ.error ? (
                <ErrorBody error={nodesQ.error} />
              ) : (
                <>
                  <BigNumber value={nodesTotal} />
                  <SubLabel>
                    <span
                      className={cn(
                        nodesReady < nodesTotal
                          ? "text-amber-400"
                          : "text-term-green",
                      )}
                    >
                      {nodesReady} ready
                    </span>{" "}
                    / {nodesTotal} total
                  </SubLabel>
                </>
              )}
            </CardShell>
          )}

          {/* Namespaces */}
          {namespacesQ.isLoading ? (
            <SkeletonCard />
          ) : (
            <CardShell icon={<Folders className="size-3.5" />} label="namespaces">
              {namespacesQ.error ? (
                <ErrorBody error={namespacesQ.error} />
              ) : (
                <>
                  <BigNumber value={namespacesQ.data?.length ?? 0} />
                  <SubLabel>logical partitions</SubLabel>
                </>
              )}
            </CardShell>
          )}

          {/* Workloads */}
          {workloadsQ.isLoading && fleetQ.isLoading ? (
            <SkeletonCard />
          ) : (
            <CardShell icon={<Boxes className="size-3.5" />} label="workloads">
              {workloadsQ.error && fleetQ.error ? (
                <ErrorBody error={workloadsQ.error ?? fleetQ.error} />
              ) : (
                <>
                  <BigNumber value={workloadsTotal} />
                  <SubLabel>
                    <span className="text-term-green">
                      {wlBreakdown.healthy} running
                    </span>
                    <span className="text-term-subtle"> · </span>
                    <span className="text-amber-400">
                      {wlBreakdown.degraded} degraded
                    </span>
                    <span className="text-term-subtle"> · </span>
                    <span className="text-term-red">
                      {wlBreakdown.failed} failed
                    </span>
                  </SubLabel>
                </>
              )}
            </CardShell>
          )}

          {/* Pods */}
          {fleetQ.isLoading ? (
            <SkeletonCard />
          ) : (
            <CardShell icon={<CircleDot className="size-3.5" />} label="pods">
              {fleetQ.error ? (
                <ErrorBody error={fleetQ.error} />
              ) : !pods ? (
                <BigNumber
                  value={<span className="text-term-subtle">—</span>}
                />
              ) : (
                <>
                  <BigNumber value={pods.pods_total} />
                  <SubLabel>
                    <span className="text-term-green">
                      {pods.pods_ready} ready
                    </span>
                    <span className="text-term-subtle"> · </span>
                    <span className="text-amber-400">
                      {pods.pods_pending} pending
                    </span>
                    <span className="text-term-subtle"> · </span>
                    <span className="text-term-red">
                      {pods.pods_failed} failed
                    </span>
                  </SubLabel>
                </>
              )}
            </CardShell>
          )}

          {/* CPU usage */}
          {fleetQ.isLoading ? (
            <SkeletonCard />
          ) : (
            <CardShell icon={<Cpu className="size-3.5" />} label="cpu usage">
              {fleetQ.error ? (
                <ErrorBody error={fleetQ.error} />
              ) : fleetCard?.cpu_percent === null ||
                fleetCard?.cpu_percent === undefined ? (
                <>
                  <BigNumber
                    value={<span className="text-term-subtle">—</span>}
                  />
                  <SubLabel>metrics-server unavailable</SubLabel>
                </>
              ) : (
                <>
                  <BigNumber value={`${Math.round(fleetCard.cpu_percent)}%`} />
                  <SubLabel>fleet aggregate</SubLabel>
                </>
              )}
            </CardShell>
          )}

          {/* Memory usage */}
          {fleetQ.isLoading ? (
            <SkeletonCard />
          ) : (
            <CardShell
              icon={<MemoryStick className="size-3.5" />}
              label="memory usage"
            >
              {fleetQ.error ? (
                <ErrorBody error={fleetQ.error} />
              ) : fleetCard?.mem_percent === null ||
                fleetCard?.mem_percent === undefined ? (
                <>
                  <BigNumber
                    value={<span className="text-term-subtle">—</span>}
                  />
                  <SubLabel>metrics-server unavailable</SubLabel>
                </>
              ) : (
                <>
                  <BigNumber value={`${Math.round(fleetCard.mem_percent)}%`} />
                  <SubLabel>fleet aggregate</SubLabel>
                </>
              )}
            </CardShell>
          )}
        </div>
      </div>
    </div>
  );
}
