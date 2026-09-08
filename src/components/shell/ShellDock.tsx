import { useRef, useState } from "react";
import { X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useShellDockStore, type ShellTab } from "@/state/shellDockStore";
import { k8s } from "@/lib/k8s";
import { ShellPanel } from "./ShellPanel";
import { ShellTabStrip } from "./ShellTabStrip";

const MIN_HEIGHT = 200;
const MAX_VH = 0.8;
const DEFAULT_HEIGHT = 320;
const STORAGE_KEY = "lumen:shell-dock:height";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * Bottom-docked shell panel mounted at the app shell. Hidden when there
 * are no sessions; auto-shows on first openSession from useShellDock.
 */
export function ShellDock() {
  const tabs = useShellDockStore((s) => s.tabs);
  const activeTabId = useShellDockStore((s) => s.activeTabId);
  const isOpen = useShellDockStore((s) => s.isOpen);
  const mru = useShellDockStore((s) => s.mru);
  const setActiveTab = useShellDockStore((s) => s.setActiveTab);
  const closeTab = useShellDockStore((s) => s.closeTab);
  const closeDock = useShellDockStore((s) => s.closeDock);
  const openSession = useShellDockStore((s) => s.openSession);

  const [height, setHeight] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_HEIGHT;
    const saved = window.localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= MIN_HEIGHT ? parsed : DEFAULT_HEIGHT;
  });
  const heightRef = useRef(height);
  heightRef.current = height;

  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = heightRef.current;
    const onMove = (ev: PointerEvent) => {
      const max = window.innerHeight * MAX_VH;
      const next = Math.max(MIN_HEIGHT, Math.min(max, startH + (startY - ev.clientY)));
      setHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.localStorage.setItem(STORAGE_KEY, String(Math.round(heightRef.current)));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  if (!isOpen || !activeTab) return null;

  function handleClose() {
    const live = tabs.some((t) => {
      const st = t.session.getState();
      return st === "live" || st === "starting";
    });
    if (live) {
      const ok = window.confirm(`Close ${tabs.length} active shell session${tabs.length === 1 ? "" : "s"}?`);
      if (!ok) return;
    }
    closeDock();
  }

  function handleCloseTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    const st = tab.session.getState();
    if (st === "live" || st === "starting") {
      const ok = window.confirm("close active shell session?");
      if (!ok) return;
    }
    closeTab(id);
  }

  function handleRestart(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    // ShellTerminalHost owns the live cols/rows; from here we kick a
    // sane default and the host's ResizeObserver will correct on next
    // frame.
    void tab.session.restart(DEFAULT_COLS, DEFAULT_ROWS);
  }

  return (
    <div
      className={cn(
        "fixed bottom-0 left-0 right-0 z-30",
        "bg-term-panel border-t border-term-border-soft shadow-2xl",
        "flex flex-col",
      )}
      style={{ height }}
      role="region"
      aria-label="shell dock"
    >
      <div
        onPointerDown={startResize}
        className="absolute left-0 right-0 top-0 h-1 cursor-row-resize z-10 group"
        title="drag to resize"
      >
        <div className="absolute inset-x-0 top-0 h-px bg-transparent group-hover:bg-term-green/60 transition-colors" />
      </div>
      <div className="shrink-0 flex items-center gap-2 h-7 px-3 border-b border-term-border-soft bg-term-panel-2">
        <span className="text-[10px] uppercase tracking-wider text-term-muted">shell</span>
        <span className="text-term-subtle">·</span>
        <span className="text-[11px] text-term-fg font-mono truncate flex-1">
          {activeTab.podName} · {activeTab.container} · {activeTab.commandLabel}
        </span>
        <button
          type="button"
          onClick={handleClose}
          className="text-term-subtle hover:text-term-red"
          title="close dock"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <ShellTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        mru={mru}
        onSelect={setActiveTab}
        onClose={handleCloseTab}
        onRestart={handleRestart}
        onOpenFromMru={(key) => { openSession(key); }}
      />
      <ContainerListProvider tab={activeTab} />
    </div>
  );
}

function ContainerListProvider({ tab }: { tab: ShellTab }) {
  const ctx = tab.session.context;
  const namespace = tab.session.namespace;
  const pod = tab.session.pod;
  const { data } = useQuery({
    queryKey: ["k8s", "pod-containers", ctx, namespace, pod],
    queryFn: () => k8s.listPodContainers(namespace, pod, ctx || undefined),
    staleTime: 60_000,
  });
  const opts = (data ?? []).filter((c) => !c.is_init).map((c) => ({ name: c.name }));
  if (tab.session.container && !opts.some((item) => item.name === tab.session.container)) opts.push({ name: tab.session.container });
  return <ShellPanel
    key={JSON.stringify([tab.id, tab.session.container, tab.session.command])}
    session={tab.session} containerOptions={opts}
    onStartSelection={(container, command) => useShellDockStore.getState().replaceSession(tab.id, { container, command })}
  />;
}
