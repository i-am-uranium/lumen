import { useEffect, useMemo, useReducer, type Dispatch } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { k8s } from "@/lib/k8s";
import type { WorkloadKind } from "@/lib/k8s";
import { LogsPanel } from "./LogsPanel";
import { LogsAggregatePanel } from "./LogsAggregatePanel";
import { LogsTabStrip } from "./LogsTabStrip";
import {
  panelReducer,
  initialPanel,
  allTabsSorted,
  isAggregateTab,
  type SinglePodTab,
  type PanelTree,
  type LeafPanel,
  type PanelAction,
} from "@/state/logPanels";
import type { ContainerOption } from "./LogsContainerPills";

const WORKLOAD_KINDS: ReadonlySet<string> = new Set([
  "deployment", "statefulset", "daemonset", "replicaset", "job",
]);

export function LogsViewer({
  ctx, namespace, kind, name,
}: {
  ctx: string;
  namespace: string;
  kind: string;
  name: string;
}) {
  const isWorkload = WORKLOAD_KINDS.has(kind);
  const podsQuery = useQuery({
    queryKey: ["k8s", "pods-for", ctx, namespace, kind, name],
    queryFn: () => k8s.listPodsFor(namespace, kind as WorkloadKind, name, ctx),
    enabled: isWorkload,
    staleTime: 5_000,
  });
  const childPods = podsQuery.data?.map((w) => w.name) ?? [];

  const firstPod = isWorkload ? childPods[0] : name;
  const [panel, dispatch] = useReducer(panelReducer, undefined, () =>
    initialPanel({ id: `tab-${firstPod ?? name}`, podName: firstPod ?? name }),
  );

  // Flat, stable-ordered list of all tabs across the entire tree — used for
  // pod-detail queries (stable hook order) and for computing available pods.
  const allTabs = useMemo(() => allTabsSorted(panel), [panel]);

  // Once child pods load, replace the synthetic workload-name placeholder
  // with the first real pod. Do this in an effect so render stays pure.
  useEffect(() => {
    if (!isWorkload || childPods.length === 0 || allTabs.length !== 1) return;
    const [tab] = allTabs;
    if (isAggregateTab(tab)) return;
    const firstChildPod = childPods[0];
    if (tab.podName !== name || tab.podName === firstChildPod) return;
    dispatch({
      type: "replaceTab",
      tabId: tab.id,
      tab: { id: `tab-${firstChildPod}`, podName: firstChildPod },
    });
  }, [allTabs, childPods, isWorkload, name]);

  // Pod-detail queries are needed for both single-pod and aggregate tabs; the
  // aggregate path needs container lists for every member pod. Flatten to the
  // union of pod names across all tabs.
  const allPodNames = useMemo(() => {
    const set = new Set<string>();
    for (const t of allTabs) {
      if (isAggregateTab(t)) for (const p of t.pods) set.add(p);
      else set.add(t.podName);
    }
    return [...set].sort();
  }, [allTabs]);
  const containerOptionsByPod = useContainerOptionsForPods(ctx, namespace, allPodNames);

  const availablePods = useMemo(() => {
    if (!isWorkload) return [];
    // For the "+" menu we want pods not yet open in *any* single-pod tab —
    // aggregate tabs don't claim a pod exclusively, so a pod inside an
    // aggregate is still available for its own single-pod tab.
    const claimed = new Set(
      allTabs.filter((t): t is SinglePodTab => !isAggregateTab(t)).map((t) => t.podName),
    );
    return childPods.filter((p) => !claimed.has(p));
  }, [childPods, allTabs, isWorkload]);

  // Single split level: only allow split when the root is a single leaf.
  const canSplit = panel.type === "leaf";

  const renderLeaf = (leaf: LeafPanel) => (
    <div className="flex flex-col h-full min-h-0">
      {isWorkload && (
        <LogsTabStrip
          leafId={leaf.id}
          tabs={leaf.tabs}
          activeTab={leaf.activeTab}
          onSelect={(id) => dispatch({ type: "setActiveTab", tabId: id })}
          onClose={(id) => dispatch({ type: "closeTab", tabId: id })}
          availablePods={availablePods}
          // For aggregate selection, every child pod is fair game — the same
          // pod can have its own single-pod tab AND appear in an aggregate.
          aggregateCandidatePods={childPods}
          onAddTab={(podName) =>
            dispatch({ type: "addTab", tab: { id: `tab-${podName}`, podName }, leafId: leaf.id })
          }
          onAddAggregateTab={(podNames, title) => {
            // Tab id includes a timestamp so multiple aggregates with the
            // same pod set don't collide on the addTab dedupe check.
            const id = `agg-${Date.now().toString(36)}-${podNames.length}`;
            dispatch({
              type: "addTab",
              tab: { id, kind: "aggregate", title, pods: podNames },
              leafId: leaf.id,
            });
          }}
          onSplit={(dir, movingTabId) =>
            dispatch({ type: "splitPanel", sourceLeafId: leaf.id, direction: dir, movingTabId })
          }
          onMoveTab={(tabId, targetLeafId) =>
            dispatch({ type: "moveTab", tabId, targetLeafId })
          }
          canSplit={canSplit}
        />
      )}
      <div className="flex-1 min-h-0 relative">
        {leaf.tabs.map((t) => (
          <div
            key={t.id}
            className="absolute inset-0"
            style={{ display: t.id === leaf.activeTab ? "flex" : "none", flexDirection: "column" }}
          >
            {isAggregateTab(t) ? (
              <LogsAggregatePanel
                ctx={ctx}
                namespace={namespace}
                pods={t.pods}
                title={t.title}
                containersByPod={t.pods.reduce<Record<string, ContainerOption[]>>((acc, p) => {
                  acc[p] = containerOptionsByPod[p] ?? [];
                  return acc;
                }, {})}
              />
            ) : (
              <LogsPanel
                ctx={ctx}
                namespace={namespace}
                pod={t.podName}
                containers={containerOptionsByPod[t.podName] ?? []}
                resourceName={t.podName}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <PanelView panel={panel} renderLeaf={renderLeaf} dispatch={dispatch} />
    </div>
  );
}

function PanelView({
  panel,
  renderLeaf,
}: {
  panel: PanelTree;
  renderLeaf: (leaf: LeafPanel) => React.ReactNode;
  dispatch: Dispatch<PanelAction>;
}) {
  if (panel.type === "leaf") {
    return <div className="flex-1 min-w-0 min-h-0 flex flex-col">{renderLeaf(panel)}</div>;
  }
  const flexDir = panel.direction === "h" ? "flex-row" : "flex-col";
  return (
    <div className={`flex-1 min-w-0 min-h-0 flex ${flexDir}`}>
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">{renderLeaf(panel.a)}</div>
      <div
        className="bg-border-default shrink-0"
        style={panel.direction === "h" ? { width: 3 } : { height: 3 }}
      />
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">{renderLeaf(panel.b)}</div>
    </div>
  );
}

/**
 * Run a pod-details query per pod and return container options.
 *
 * Takes a flat, sorted list of pod names rather than tabs because aggregate
 * tabs cover N pods each — keying queries by tab id would either over-fetch
 * (per-tab × per-pod) or fight react-query's hook-order rule. Pod names
 * are the natural cache key.
 */
function useContainerOptionsForPods(
  ctx: string,
  namespace: string,
  pods: string[],
): Record<string, ContainerOption[]> {
  const queries = useQueries({
    queries: pods.map((p) => ({
      queryKey: ["k8s", "pod-details", ctx, namespace, p],
      queryFn: () => k8s.getPodDetails(ctx, namespace, p),
      staleTime: 10_000,
    })),
  });
  const out: Record<string, ContainerOption[]> = {};
  for (const [index, p] of pods.entries()) {
    const q = queries[index];
    out[p] = (q.data?.containers ?? []).map((c) => ({ name: c.name, kind: "regular" as const }));
  }
  return out;
}
