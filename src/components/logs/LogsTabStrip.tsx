import { useEffect, useMemo, useState } from "react";
import { Plus, X, SplitSquareHorizontal, Layers, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { isAggregateTab, tabLabel, type Tab, type TabId } from "@/state/logPanels";

const COLOR_PALETTE = [
  "bg-emerald-400", "bg-sky-400", "bg-fuchsia-400", "bg-amber-400",
  "bg-orange-400", "bg-rose-400", "bg-violet-400", "bg-teal-400",
  "bg-lime-400", "bg-indigo-400", "bg-pink-400", "bg-cyan-400",
];

export const TAB_DRAG_MIME = "application/x-lumen-tab";

export function podColorFor(podName: string): string {
  let h = 0;
  for (let i = 0; i < podName.length; i++) h = (h * 31 + podName.charCodeAt(i)) | 0;
  return COLOR_PALETTE[Math.abs(h) % COLOR_PALETTE.length];
}

export function LogsTabStrip({
  leafId,
  tabs,
  activeTab,
  onSelect,
  onClose,
  availablePods,
  aggregateCandidatePods,
  onAddTab,
  onAddAggregateTab,
  onSplit,
  onMoveTab,
  canSplit = true,
}: {
  leafId: string;
  tabs: Tab[];
  activeTab: TabId;
  onSelect: (id: TabId) => void;
  onClose: (id: TabId) => void;
  /** Pods not yet open in any single-pod tab. Source for the "+" single-add menu. */
  availablePods: string[];
  /**
   * Pods eligible to participate in a new aggregate tab. Distinct from
   * `availablePods` because aggregates may include pods that already have
   * their own single-pod tab — the same pod can be inspected solo *and*
   * as part of a group.
   */
  aggregateCandidatePods: string[];
  onAddTab: (podName: string) => void;
  onAddAggregateTab: (podNames: string[], title: string) => void;
  onSplit: (dir: "h" | "v", movingTabId: string) => void;
  onMoveTab: (tabId: string, targetLeafId: string) => void;
  canSplit?: boolean;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"choose" | "single" | "aggregate">("choose");
  const [aggregateSelection, setAggregateSelection] = useState<Set<string>>(new Set());
  const [aggregateTitle, setAggregateTitle] = useState("");
  const [splitOpen, setSplitOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Reset wizard state whenever the menu closes.
  useEffect(() => {
    if (!addOpen) {
      setAddMode("choose");
      setAggregateSelection(new Set());
      setAggregateTitle("");
    }
  }, [addOpen]);

  const defaultAggregateTitle = useMemo(() => {
    const n = aggregateSelection.size;
    return n === 0 ? "" : `${n} pod${n === 1 ? "" : "s"}`;
  }, [aggregateSelection]);

  function toggleAggregatePick(pod: string) {
    setAggregateSelection((prev) => {
      const next = new Set(prev);
      if (next.has(pod)) next.delete(pod);
      else next.add(pod);
      return next;
    });
  }

  function submitAggregate() {
    if (aggregateSelection.size < 2) return;
    const podsSorted = [...aggregateSelection].sort();
    const title = aggregateTitle.trim() || defaultAggregateTitle;
    onAddAggregateTab(podsSorted, title);
    setAddOpen(false);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.types.includes(TAB_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!dragOver) setDragOver(true);
    }
  }
  function handleDragLeave() {
    setDragOver(false);
  }
  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    setDragOver(false);
    const raw = e.dataTransfer.getData(TAB_DRAG_MIME);
    if (!raw) return;
    try {
      const { tabId, sourceLeafId } = JSON.parse(raw) as { tabId: string; sourceLeafId: string };
      if (sourceLeafId === leafId) return;
      e.preventDefault();
      onMoveTab(tabId, leafId);
    } catch {
      // ignore malformed payload
    }
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "shrink-0 flex items-center border-b border-border-default bg-elevated overflow-x-auto",
        dragOver && "border border-accent-primary/60",
      )}
    >
      {tabs.map((t) => {
        const active = t.id === activeTab;
        const aggregate = isAggregateTab(t);
        const label = tabLabel(t);
        const fullTitle = aggregate ? `${label} — ${t.pods.join(", ")}` : label;
        return (
          <div
            key={t.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData(
                TAB_DRAG_MIME,
                JSON.stringify({ tabId: t.id, sourceLeafId: leafId }),
              );
            }}
            onClick={() => onSelect(t.id)}
            className={cn(
              "group flex items-center gap-1.5 px-2 py-1 border-r border-border-default text-[11px] cursor-pointer shrink-0 transition-colors",
              active ? "bg-surface text-text-primary" : "text-text-muted hover:text-text-primary",
            )}
          >
            {aggregate ? (
              <Layers className="size-3 shrink-0 text-accent-primary" />
            ) : (
              <span className={cn("size-2 rounded-full shrink-0", podColorFor(label))} />
            )}
            <span className="font-mono truncate max-w-[160px]" title={fullTitle}>{label}</span>
            {tabs.length > 1 && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
                className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-danger transition-opacity"
                title="close tab"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        );
      })}
      <div className="relative">
        <Button
          type="button"
          onClick={() => { setAddOpen((o) => !o); setSplitOpen(false); }}
          disabled={availablePods.length === 0 && aggregateCandidatePods.length < 2}
          variant="ghost"
          size="icon"
          className="size-7 rounded-none"
          title="add pod tab"
        >
          <Plus className="size-3.5" />
        </Button>
        {addOpen && (
          <div className="absolute left-0 top-full mt-1 z-20 bg-surface border border-border-default rounded-control shadow-[var(--shadow-popover)] min-w-[220px]">
            {addMode === "choose" && (
              <div className="py-1">
                <button
                  type="button"
                  onClick={() => setAddMode("single")}
                  disabled={availablePods.length === 0}
                  className="flex items-center gap-2 w-full text-left px-2 py-1.5 text-[11px] text-text-primary hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="size-3 text-text-muted" />
                  <span>Open single pod</span>
                  <span className="ml-auto text-text-muted">{availablePods.length}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAddMode("aggregate")}
                  disabled={aggregateCandidatePods.length < 2}
                  className="flex items-center gap-2 w-full text-left px-2 py-1.5 text-[11px] text-text-primary hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Layers className="size-3 text-accent-primary" />
                  <span>Aggregate pods…</span>
                  <span className="ml-auto text-text-muted">2+</span>
                </button>
              </div>
            )}

            {addMode === "single" && (
              <div className="py-1 max-h-60 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => setAddMode("choose")}
                  className="flex items-center gap-1.5 w-full px-2 py-1 text-[10px] text-text-muted hover:text-text-primary border-b border-border-subtle"
                >
                  <ArrowLeft className="size-2.5" /> back
                </button>
                {availablePods.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => { onAddTab(p); setAddOpen(false); }}
                    className="block w-full text-left px-2 py-1 text-[11px] text-text-primary hover:bg-hover font-mono"
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}

            {addMode === "aggregate" && (
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => setAddMode("choose")}
                  className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-text-muted hover:text-text-primary border-b border-border-subtle"
                >
                  <ArrowLeft className="size-2.5" /> back
                </button>
                <div className="px-2 py-1.5 border-b border-border-subtle">
                  <input
                    type="text"
                    placeholder={defaultAggregateTitle || "aggregate name"}
                    value={aggregateTitle}
                    onChange={(e) => setAggregateTitle(e.target.value)}
                    className="w-full bg-elevated border border-border-default rounded-control px-2 py-1 text-[11px] text-text-primary placeholder-text-muted focus:outline-none focus:border-accent-primary/60"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto py-1">
                  {aggregateCandidatePods.map((p) => {
                    const checked = aggregateSelection.has(p);
                    return (
                      <label
                        key={p}
                        className="flex items-center gap-2 px-2 py-1 text-[11px] cursor-pointer hover:bg-hover"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAggregatePick(p)}
                          className="size-3 accent-accent-primary"
                        />
                        <span className={cn("size-2 rounded-full shrink-0", podColorFor(p))} />
                        <span className="font-mono truncate flex-1" title={p}>{p}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2 px-2 py-1.5 border-t border-border-subtle">
                  <span className="text-[10px] text-text-muted flex-1">
                    {aggregateSelection.size} selected
                  </span>
                  <Button
                    type="button"
                    onClick={submitAggregate}
                    disabled={aggregateSelection.size < 2}
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                  >
                    Create
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {canSplit && tabs.length > 1 && (
        <div className="relative">
          <Button
            type="button"
            onClick={() => { setSplitOpen((o) => !o); setAddOpen(false); }}
            variant="ghost"
            size="icon"
            className="size-7 rounded-none"
            title="split panel"
          >
            <SplitSquareHorizontal className="size-3.5" />
          </Button>
          {splitOpen && (
            <div className="absolute left-0 top-full mt-1 z-20 bg-surface border border-border-default rounded-control shadow-[var(--shadow-popover)] py-1 min-w-[140px]">
              <button
                type="button"
                onClick={() => { onSplit("h", activeTab); setSplitOpen(false); }}
                className="block w-full text-left px-2 py-1 text-[11px] text-text-primary hover:bg-hover"
              >
                split right
              </button>
              <button
                type="button"
                onClick={() => { onSplit("v", activeTab); setSplitOpen(false); }}
                className="block w-full text-left px-2 py-1 text-[11px] text-text-primary hover:bg-hover"
              >
                split down
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
