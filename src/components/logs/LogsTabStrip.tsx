import { useState } from "react";
import { Plus, X, SplitSquareHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Tab, TabId } from "@/state/logPanels";

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
  onAddTab,
  onSplit,
  onMoveTab,
  canSplit = true,
}: {
  leafId: string;
  tabs: Tab[];
  activeTab: TabId;
  onSelect: (id: TabId) => void;
  onClose: (id: TabId) => void;
  /** Pods not yet in the strip. */
  availablePods: string[];
  onAddTab: (podName: string) => void;
  onSplit: (dir: "h" | "v", movingTabId: string) => void;
  onMoveTab: (tabId: string, targetLeafId: string) => void;
  canSplit?: boolean;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

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
            <span className={cn("size-2 rounded-full shrink-0", podColorFor(t.podName))} />
            <span className="font-mono truncate max-w-[160px]" title={t.podName}>{t.podName}</span>
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
          disabled={availablePods.length === 0}
          variant="ghost"
          size="icon"
          className="size-7 rounded-none"
          title="add pod tab"
        >
          <Plus className="size-3.5" />
        </Button>
        {addOpen && availablePods.length > 0 && (
          <div className="absolute left-0 top-full mt-1 z-20 bg-surface border border-border-default rounded-control shadow-[var(--shadow-popover)] py-1 max-h-60 overflow-y-auto min-w-[180px]">
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
