import { useEffect, useRef, useState } from "react";
import { Plus, RotateCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useShellSession } from "@/hooks/useShellSession";
import type { ShellTab } from "@/state/shellDockStore";
import type { ShellSessionKey } from "@/state/shellSession";
import { podColorFor } from "@/components/logs/LogsTabStrip";

const STATE_DOT: Record<string, string> = {
  starting: "bg-warning animate-pulse",
  live: "bg-term-green",
  exited: "bg-term-subtle",
  failed: "bg-term-red",
  idle: "bg-term-subtle",
};

export function ShellTabStrip({
  tabs,
  activeTabId,
  mru,
  onSelect,
  onClose,
  onRestart,
  onOpenFromMru,
}: {
  tabs: ShellTab[];
  activeTabId: string | null;
  mru: ShellSessionKey[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRestart: (id: string) => void;
  onOpenFromMru: (key: ShellSessionKey) => void;
}) {
  const [mruOpen, setMruOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mruOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setMruOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [mruOpen]);

  return (
    <div className="shrink-0 flex items-center border-b border-term-border-soft bg-term-panel-2 overflow-x-auto">
      {tabs.map((t) => (
        <ShellTabItem
          key={t.id}
          tab={t}
          active={t.id === activeTabId}
          showClose={tabs.length > 1}
          onSelect={() => onSelect(t.id)}
          onClose={() => onClose(t.id)}
          onRestart={() => onRestart(t.id)}
        />
      ))}
      <div className="relative" ref={popoverRef}>
        <button
          type="button"
          onClick={() => setMruOpen((o) => !o)}
          className="px-2 py-1 text-term-muted hover:text-term-fg"
          title="recent shells"
        >
          <Plus className="size-3.5" />
        </button>
        {mruOpen && (
          <div className="absolute left-0 top-full mt-1 z-20 bg-term-panel border border-term-border-soft rounded shadow-lg py-1 min-w-[260px] max-h-72 overflow-y-auto">
            {mru.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-term-subtle">
                no recent pods — open a shell from a pod drawer
              </div>
            ) : (
              mru.map((key) => (
                <button
                  key={`${key.context}-${key.namespace}-${key.pod}`}
                  type="button"
                  onClick={() => {
                    onOpenFromMru(key);
                    setMruOpen(false);
                  }}
                  className="block w-full text-left px-2 py-1 text-[11px] text-term-fg hover:bg-term-panel-2 font-mono"
                >
                  <span className={cn("inline-block size-2 rounded-full mr-1.5 align-middle", podColorFor(key.pod))} />
                  <span>{key.pod}</span>
                  <span className="text-term-subtle"> · {key.namespace} · {key.container}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ShellTabItem({
  tab,
  active,
  showClose,
  onSelect,
  onClose,
  onRestart,
}: {
  tab: ShellTab;
  active: boolean;
  showClose: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRestart: () => void;
}) {
  // Subscribe so the state-dot updates as the session transitions.
  useShellSession(tab.session);
  const state = tab.session.getState();
  const canRestart = state === "exited" || state === "failed";
  return (
    <div
      onClick={onSelect}
      className={cn(
        "group flex items-center gap-1.5 px-2 py-1 border-r border-term-border-soft text-[11px] cursor-pointer shrink-0",
        active ? "bg-term-panel text-term-fg" : "text-term-subtle hover:text-term-fg",
      )}
    >
      <span className={cn("size-2 rounded-full shrink-0", podColorFor(tab.podName))} />
      <span className="font-mono truncate max-w-[160px]" title={tab.podName}>{tab.podName}</span>
      <span className="text-term-subtle font-mono truncate max-w-[100px]" title={tab.container}>
        · {tab.container}
      </span>
      <span
        className={cn("size-1.5 rounded-full shrink-0", STATE_DOT[state] ?? "bg-term-subtle")}
        title={`status: ${state}`}
      />
      {canRestart && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRestart(); }}
          className="text-term-subtle hover:text-term-green"
          title="restart session"
        >
          <RotateCw className="size-3" />
        </button>
      )}
      {showClose && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="opacity-0 group-hover:opacity-100 text-term-subtle hover:text-term-red transition-opacity"
          title="close tab"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}
