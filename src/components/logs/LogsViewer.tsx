import { useEffect, useMemo, useReducer, type Dispatch } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { k8s } from "@/lib/k8s";
import type { WorkloadKind } from "@/lib/k8s";
import { LogsPanel } from "./LogsPanel";
import { LogsTabStrip } from "./LogsTabStrip";
import {
  panelReducer,
  initialPanel,
  allTabsSorted,
  type Tab,
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
    const firstChildPod = childPods[0];
    if (tab.podName !== name || tab.podName === firstChildPod) return;
    dispatch({
      type: "replaceTab",
      tabId: tab.id,
      tab: { id: `tab-${firstChildPod}`, podName: firstChildPod },
    });
  }, [allTabs, childPods, isWorkload, name]);

  const containerOptionsByPod = useContainerOptionsForTabs(ctx, namespace, allTabs);

  const openPodNames = useMemo(
    () => new Set(allTabs.map((t) => t.podName)),
    [allTabs],
  );
  const availablePods = useMemo(() => {
    if (!isWorkload) return [];
    return childPods.filter((p) => !openPodNames.has(p));
  }, [childPods, openPodNames, isWorkload]);

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
          onAddTab={(podName) =>
            dispatch({ type: "addTab", tab: { id: `tab-${podName}`, podName }, leafId: leaf.id })
          }
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
            <LogsPanel
              ctx={ctx}
              namespace={namespace}
              pod={t.podName}
              containers={containerOptionsByPod[t.podName] ?? []}
              resourceName={t.podName}
            />
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

/** Run a pod-details query per open tab and return container options. */
function useContainerOptionsForTabs(
  ctx: string,
  namespace: string,
  tabs: Tab[],
): Record<string, ContainerOption[]> {
  const queries = useQueries({
    queries: tabs.map((t) => ({
      queryKey: ["k8s", "pod-details", ctx, namespace, t.podName],
      queryFn: () => k8s.getPodDetails(ctx, namespace, t.podName),
      staleTime: 10_000,
    })),
  });
  const out: Record<string, ContainerOption[]> = {};
  for (const [index, t] of tabs.entries()) {
    const q = queries[index];
    out[t.podName] = (q.data?.containers ?? []).map((c) => ({ name: c.name, kind: "regular" as const }));
  }
  return out;
}
