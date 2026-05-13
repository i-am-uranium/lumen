import { useEffect } from "react";
import { Plus, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { TABS_NEW_URL, useTabsStore } from "@/state/tabs";

/**
 * Horizontal tab strip. Each tab is a frozen URL — clicking navigates
 * to it; in-app navigation updates the active tab's URL in place via
 * <TabsSyncer />. Multiple tabs across different cluster contexts
 * let users keep several investigations open without losing place.
 */
export function TabBar() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const setActive = useTabsStore((s) => s.setActive);
  const closeTab = useTabsStore((s) => s.closeTab);
  const openTab = useTabsStore((s) => s.openTab);

  // Don't render the strip until the syncer has seeded a tab — avoids
  // a one-frame empty bar on first load.
  if (tabs.length === 0) return null;

  const onSelect = (id: string) => {
    if (id === activeId) return;
    setActive(id);
    const tab = useTabsStore.getState().tabs.find((t) => t.id === id);
    if (tab) navigate(tab.url);
  };

  const onClose = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const nextId = closeTab(id);
    if (nextId && nextId !== activeId) {
      const tab = useTabsStore.getState().tabs.find((t) => t.id === nextId);
      if (tab) navigate(tab.url);
    }
  };

  const onMiddleClick = (id: string, e: React.MouseEvent) => {
    // Middle-click closes a tab — matches browser convention.
    if (e.button !== 1) return;
    e.preventDefault();
    onClose(id, e);
  };

  const onAdd = () => {
    // Stash the current pathname into the active tab before opening a
    // fresh one, so the user's in-progress view isn't lost if it had
    // drifted from the persisted URL.
    if (activeId) useTabsStore.getState().syncActiveUrl(pathname + search);
    openTab(TABS_NEW_URL);
    navigate(TABS_NEW_URL);
  };

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-term-border-soft bg-term-panel px-2 py-1">
      <div role="tablist" className="flex min-w-0 items-center gap-1">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              onMouseDown={(e) => onMiddleClick(tab.id, e)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(tab.id);
                }
              }}
              title={tab.url}
              className={cn(
                "group inline-flex h-7 max-w-[220px] cursor-pointer items-center gap-1.5 rounded-[6px] border px-2 text-[12px] transition-colors",
                active
                  ? "border-accent-primary/40 bg-accent-primary-soft text-accent-primary"
                  : "border-term-border-soft bg-term-bg/70 text-term-muted hover:border-accent-primary/35 hover:text-term-fg",
              )}
            >
              {tab.context && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    active ? "bg-accent-primary" : "bg-term-subtle",
                  )}
                />
              )}
              <span className="truncate font-mono">{tab.title}</span>
              <button
                type="button"
                aria-label={`Close tab ${tab.title}`}
                onClick={(e) => onClose(tab.id, e)}
                className={cn(
                  "ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-[3px] opacity-0 transition-opacity",
                  "hover:bg-term-border-soft group-hover:opacity-100",
                  active && "opacity-70",
                )}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
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
