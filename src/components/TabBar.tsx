import { startTransition, useEffect, useRef, useState } from "react";
import { Pin, PinOff, Plus, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  TABS_NEW_URL,
  getPaneTabs,
  useTabsStore,
  visibleOrder,
  type Tab,
} from "@/state/tabs";

/**
 * Stable empty-array reference for selectors below. Using `?? []`
 * inline would allocate a fresh array each render, breaking zustand's
 * Object.is equality check and causing a render-loop until the pane
 * finishes initialising (visible as a tab-strip flicker on tab open).
 */
const EMPTY_TABS: readonly Tab[] = [];

/**
 * Horizontal tab strip — one strip per pane. Each tab is a frozen URL;
 * clicking navigates to it via the pane's local MemoryRouter, so
 * switching tabs in one pane does not affect any other pane.
 *
 * Interactions:
 *   - Left click       → switch to tab (this pane only)
 *   - Middle click / X → close (pinned tabs hide the X; middle still closes)
 *   - Right click      → context menu (close, others, right, duplicate, pin)
 *   - Drag             → reorder within section
 *   - +                → new fleet tab in this pane
 */
export function TabBar({ paneId }: { paneId: string }) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const tabs = useTabsStore((s) => s.byPane[paneId]?.tabs ?? EMPTY_TABS);
  const activeId = useTabsStore((s) => s.byPane[paneId]?.activeId ?? null);
  const ordered = visibleOrder(tabs);

  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ tab: Tab; x: number; y: number } | null>(
    null,
  );

  if (tabs.length === 0) return null;

  const navigateToTab = (id: string) => {
    const tab = getPaneTabs(paneId).tabs.find((t) => t.id === id);
    if (tab) navigate(tab.url);
  };

  const onSelect = (id: string) => {
    if (id === activeId) return;
    useTabsStore.getState().setActive(paneId, id);
    navigateToTab(id);
  };

  const onClose = (id: string) => {
    const nextId = useTabsStore.getState().closeTab(paneId, id);
    if (nextId && nextId !== activeId) navigateToTab(nextId);
  };

  const onMiddleClick = (id: string, e: React.MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    onClose(id);
  };

  const onAdd = () => {
    // Wrap the three state writes in startTransition so React batches
    // them into a single render commit — without this the user sees an
    // intermediate frame between the tab-strip swap and the route
    // navigation, which reads as flicker.
    startTransition(() => {
      if (activeId) {
        useTabsStore.getState().syncActiveUrl(paneId, pathname + search);
      }
      useTabsStore.getState().openTab(paneId, TABS_NEW_URL);
      navigate(TABS_NEW_URL);
    });
  };

  const onContextMenu = (e: React.MouseEvent, tab: Tab) => {
    e.preventDefault();
    setMenu({ tab, x: e.clientX, y: e.clientY });
  };

  const onDragStart = (index: number, e: React.DragEvent) => {
    setDragFromIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  };

  const onDragOver = (index: number, e: React.DragEvent) => {
    if (dragFromIndex === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  };

  const onDrop = (index: number, e: React.DragEvent) => {
    e.preventDefault();
    if (dragFromIndex === null || dragFromIndex === index) {
      setDragFromIndex(null);
      setDragOverIndex(null);
      return;
    }
    useTabsStore.getState().reorderTab(paneId, dragFromIndex, index);
    setDragFromIndex(null);
    setDragOverIndex(null);
  };

  const onDragEnd = () => {
    setDragFromIndex(null);
    setDragOverIndex(null);
  };

  return (
    <>
      <div className="flex items-center gap-1 overflow-x-auto border-b border-term-border-soft bg-term-panel px-2 py-1">
        <div role="tablist" className="flex min-w-0 items-center gap-1">
          {ordered.map((tab, index) => {
            const active = tab.id === activeId;
            const dragTarget = dragOverIndex === index && dragFromIndex !== null;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                draggable
                onDragStart={(e) => onDragStart(index, e)}
                onDragOver={(e) => onDragOver(index, e)}
                onDrop={(e) => onDrop(index, e)}
                onDragEnd={onDragEnd}
                onClick={() => onSelect(tab.id)}
                onMouseDown={(e) => onMiddleClick(tab.id, e)}
                onContextMenu={(e) => onContextMenu(e, tab)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(tab.id);
                  }
                }}
                title={tab.url}
                data-testid={`tab-${tab.id}`}
                className={cn(
                  "group inline-flex h-7 max-w-[220px] cursor-pointer items-center gap-1.5 rounded-[6px] border px-2 text-[12px] transition-colors",
                  active
                    ? "border-accent-primary/40 bg-accent-primary-soft text-accent-primary"
                    : "border-term-border-soft bg-term-bg/70 text-term-muted hover:border-accent-primary/35 hover:text-term-fg",
                  dragTarget && "ring-2 ring-accent-primary/60",
                  tab.pinned && "max-w-[140px]",
                )}
              >
                {tab.pinned ? (
                  <Pin
                    className={cn(
                      "size-3 shrink-0",
                      active ? "text-accent-primary" : "text-term-muted",
                    )}
                    aria-hidden="true"
                  />
                ) : (
                  tab.context && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        active ? "bg-accent-primary" : "bg-term-subtle",
                      )}
                    />
                  )
                )}
                <span className="truncate font-mono">{tab.title}</span>
                {!tab.pinned && (
                  <button
                    type="button"
                    aria-label={`Close tab ${tab.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.id);
                    }}
                    className={cn(
                      "ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] opacity-0 transition-opacity",
                      "hover:bg-term-border-soft group-hover:opacity-100",
                      active && "opacity-70",
                    )}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onAdd}
          title="New tab (Cmd+T)"
          aria-label="New tab"
          className={cn(
            "ml-1 inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] border border-term-border-soft bg-term-bg/70 text-term-muted transition-colors",
            "hover:border-accent-primary/35 hover:text-term-fg",
          )}
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      {menu && (
        <TabContextMenu
          tab={menu.tab}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onAction={(action) => {
            const store = useTabsStore.getState();
            const id = menu.tab.id;
            setMenu(null);
            switch (action) {
              case "close":
                onClose(id);
                return;
              case "closeOthers": {
                store.closeOthers(paneId, id);
                if (activeId !== id) navigateToTab(id);
                return;
              }
              case "closeRight":
                store.closeToRight(paneId, id);
                return;
              case "duplicate": {
                const copyId = store.duplicateTab(paneId, id);
                if (copyId) navigateToTab(copyId);
                return;
              }
              case "pin":
                store.pinTab(paneId, id);
                return;
              case "unpin":
                store.unpinTab(paneId, id);
                return;
            }
          }}
        />
      )}
    </>
  );
}

type ContextMenuAction =
  | "close"
  | "closeOthers"
  | "closeRight"
  | "duplicate"
  | "pin"
  | "unpin";

function TabContextMenu(props: {
  tab: Tab;
  x: number;
  y: number;
  onClose: () => void;
  onAction: (action: ContextMenuAction) => void;
}) {
  const { tab, x, y, onClose, onAction } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const viewportW = typeof window === "undefined" ? 1024 : window.innerWidth;
  const left = Math.min(x, viewportW - 200);

  const items: { id: ContextMenuAction; label: string }[] = [
    { id: "close", label: "Close" },
    { id: "closeOthers", label: "Close others" },
    { id: "closeRight", label: "Close to the right" },
    { id: "duplicate", label: "Duplicate" },
    tab.pinned
      ? { id: "unpin", label: "Unpin" }
      : { id: "pin", label: "Pin" },
  ];

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top: y }}
      className="fixed z-40 w-[180px] overflow-hidden rounded-control border border-border-default bg-surface text-[12px] shadow-[var(--shadow-popover)]"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          onClick={() => onAction(item.id)}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-text-primary transition-colors hover:bg-hover"
        >
          {item.id === "pin" && <Pin className="size-3" aria-hidden="true" />}
          {item.id === "unpin" && <PinOff className="size-3" aria-hidden="true" />}
          <span className="flex-1">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Per-pane location/tab syncer. Mirrors the enclosing MemoryRouter's
 * location into this pane's tabs entry, seeds the first tab if empty,
 * and pushes the location into the panes store so the focused-pane
 * URL stays current for chrome consumers.
 */
export function TabsSyncer({ paneId }: { paneId: string }) {
  const { pathname, search } = useLocation();
  const ensureSeeded = useTabsStore((s) => s.ensureSeeded);
  const syncActiveUrl = useTabsStore((s) => s.syncActiveUrl);

  useEffect(() => {
    const url = pathname + search;
    ensureSeeded(paneId, url);
    syncActiveUrl(paneId, url);
  }, [paneId, pathname, search, ensureSeeded, syncActiveUrl]);

  return null;
}
