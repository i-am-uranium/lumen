import { useEffect, useRef, useState } from "react";
import { Pin, PinOff, Plus, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { TABS_NEW_URL, useTabsStore, visibleOrder, type Tab } from "@/state/tabs";

/**
 * Horizontal tab strip. Each tab is a frozen URL — clicking navigates
 * to it; in-app navigation updates the active tab's URL in place via
 * <TabsSyncer />. Multiple tabs across different cluster contexts
 * let users keep several investigations open without losing place.
 *
 * Interactions:
 *   - Left click       → switch to tab
 *   - Middle click / X → close (pinned tabs hide the X; middle still closes)
 *   - Right click      → context menu (close, others, right, duplicate, pin)
 *   - Drag             → reorder within section
 *   - +                → new fleet tab
 */
export function TabBar() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const ordered = visibleOrder(tabs);

  // Drag state. We track the source index in the visible order; the
  // destination index is computed on dragover from the target's index.
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Right-click menu — position + which tab it's anchored to.
  const [menu, setMenu] = useState<{ tab: Tab; x: number; y: number } | null>(
    null,
  );

  if (tabs.length === 0) return null;

  const navigateToTab = (id: string) => {
    const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
    if (tab) navigate(tab.url);
  };

  const onSelect = (id: string) => {
    if (id === activeId) return;
    useTabsStore.getState().setActive(id);
    navigateToTab(id);
  };

  const onClose = (id: string) => {
    const nextId = useTabsStore.getState().closeTab(id);
    if (nextId && nextId !== activeId) navigateToTab(nextId);
  };

  const onMiddleClick = (id: string, e: React.MouseEvent) => {
    // Middle-click closes the tab — works on pinned tabs too since the
    // X is hidden in that state but users still need a way out.
    if (e.button !== 1) return;
    e.preventDefault();
    onClose(id);
  };

  const onAdd = () => {
    // Stash the current pathname into the active tab before opening a
    // fresh one, so the user's in-progress view isn't lost if it had
    // drifted from the persisted URL.
    if (activeId) useTabsStore.getState().syncActiveUrl(pathname + search);
    useTabsStore.getState().openTab(TABS_NEW_URL);
    navigate(TABS_NEW_URL);
  };

  const onContextMenu = (e: React.MouseEvent, tab: Tab) => {
    e.preventDefault();
    setMenu({ tab, x: e.clientX, y: e.clientY });
  };

  const onDragStart = (index: number, e: React.DragEvent) => {
    setDragFromIndex(index);
    // Required for the drag to actually fire in Firefox; we don't use
    // the payload since the source is tracked in component state.
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
    useTabsStore.getState().reorderTab(dragFromIndex, index);
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
                  // Pinned tabs are visually narrower so a long pinned
                  // row doesn't crowd out unpinned tabs.
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
                store.closeOthers(id);
                if (activeId !== id) navigateToTab(id);
                return;
              }
              case "closeRight":
                store.closeToRight(id);
                return;
              case "duplicate": {
                const copyId = store.duplicateTab(id);
                if (copyId) navigateToTab(copyId);
                return;
              }
              case "pin":
                store.pinTab(id);
                return;
              case "unpin":
                store.unpinTab(id);
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

  // Clamp to viewport so the menu doesn't render off-screen near the
  // right edge — the strip can sit far right when many tabs are open.
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
 * Keeps the active tab's URL in sync with the router. Mounted once
 * inside <BrowserRouter>. Also seeds the first tab on initial load so
 * the user never sees an empty strip.
 */
export function TabsSyncer() {
  const { pathname, search } = useLocation();
  const ensureSeeded = useTabsStore((s) => s.ensureSeeded);
  const syncActiveUrl = useTabsStore((s) => s.syncActiveUrl);

  useEffect(() => {
    const url = pathname + search;
    ensureSeeded(url);
    syncActiveUrl(url);
  }, [pathname, search, ensureSeeded, syncActiveUrl]);

  return null;
}
