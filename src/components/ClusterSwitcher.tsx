import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Network, Search } from "lucide-react";
import { k8s, type ContextInfo } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { shouldOpenInNewTab } from "@/state/tabs";

export function clusterSwitchPath(
  pathname: string,
  search: string,
  currentContext: string,
  nextContext: string,
): string {
  const currentPrefix = `/cluster/${encodeURIComponent(currentContext)}`;
  const nextPrefix = `/cluster/${encodeURIComponent(nextContext)}`;
  const suffix = pathname.startsWith(currentPrefix)
    ? pathname.slice(currentPrefix.length)
    : "";
  return `${nextPrefix}${suffix || "/workloads"}${search}`;
}

export function useClusterContexts(enabled = true) {
  return {
    queryKey: ["k8s", "contexts"],
    queryFn: k8s.listContexts,
    enabled,
    staleTime: 60_000,
  } as const;
}

export function ClusterSwitcher({
  context,
  isProd,
  cluster,
  contexts,
  onSwitchContext,
  variant = "rail",
}: {
  context: string;
  isProd: boolean;
  cluster?: string | null;
  contexts: ContextInfo[];
  onSwitchContext: (
    context: string,
    opts?: { inNewTab?: boolean },
  ) => Promise<void>;
  variant?: "rail" | "top";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredContexts = useMemo(() => {
    if (!normalizedQuery) return contexts;
    return contexts.filter((item) =>
      [item.name, item.cluster, item.user]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(normalizedQuery)),
    );
  }, [contexts, normalizedQuery]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  async function chooseContext(
    nextContext: string,
    opts: { inNewTab?: boolean } = {},
  ) {
    if (nextContext === context && !opts.inNewTab) {
      setOpen(false);
      setQuery("");
      return;
    }
    setSwitching(nextContext);
    try {
      await onSwitchContext(nextContext, opts);
      setOpen(false);
      setQuery("");
    } finally {
      setSwitching(null);
    }
  }

  const top = variant === "top";

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative min-w-0",
        top ? "w-[min(18rem,36vw)] max-w-[18rem]" : "flex-1",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="switch cluster"
        className={cn(
          "w-full min-w-0 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
          top
            ? "inline-flex h-8 items-center gap-2 rounded-[6px] border border-term-green/40 bg-term-green/10 px-2 text-term-green hover:border-term-green/70 hover:bg-term-green/15"
            : "flex flex-col rounded-control px-1.5 py-0.5 hover:bg-hover",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "truncate",
              top ? "font-mono text-[12px]" : "mds-heading text-[13px] text-text-primary",
            )}
            title={context}
          >
            {context}
          </span>
          {isProd && top && (
            <span className="rounded border border-danger/40 bg-danger/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-danger">
              prod
            </span>
          )}
          <ChevronDown
            className={cn(
              "size-3 shrink-0 transition-transform",
              top ? "text-term-green/80" : "text-text-muted",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </span>
        {!top && (
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
            {isProd && (
              <span className="rounded border border-danger/40 bg-danger/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-danger">
                prod
              </span>
            )}
            {cluster && (
              <span className="truncate text-[10px] text-text-muted" title={cluster}>
                {cluster}
              </span>
            )}
          </span>
        )}
      </button>

      {open && (
        <div
          className={cn(
            "absolute z-30 overflow-hidden rounded-panel border border-border-default bg-shell shadow-[var(--shadow-panel)]",
            top
              ? "left-0 top-[calc(100%+6px)] w-80 max-w-[calc(100vw-2rem)]"
              : "left-0 right-0 top-[calc(100%+4px)]",
          )}
        >
          <div className="flex items-center gap-2 border-b border-border-subtle px-2 py-2">
            <Search className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                  setQuery("");
                }
              }}
              placeholder="switch cluster..."
              className="h-7 min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-muted"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1" role="listbox" aria-label="clusters">
            {filteredContexts.length ? (
              filteredContexts.map((item) => {
                const active = item.name === context;
                const busy = switching === item.name;
                return (
                  <button
                    key={item.name}
                    type="button"
                    role="option"
                    aria-selected={active}
                    disabled={!!switching}
                    title="Click to switch · Cmd/Middle-click for new tab"
                    onClick={(event) =>
                      void chooseContext(item.name, {
                        inNewTab: shouldOpenInNewTab(event),
                      })
                    }
                    onAuxClick={(event) => {
                      // Middle-click on the row opens in a new tab.
                      if (event.button !== 1) return;
                      event.preventDefault();
                      void chooseContext(item.name, { inNewTab: true });
                    }}
                    className={cn(
                      "flex w-full min-w-0 items-start gap-2 rounded-control px-2 py-2 text-left transition-colors",
                      active
                        ? "bg-accent-primary-soft text-text-primary"
                        : "text-text-secondary hover:bg-hover hover:text-text-primary",
                      switching && "opacity-60",
                    )}
                  >
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                      {active || busy ? (
                        <Check className="size-3.5 text-accent-primary" aria-hidden="true" />
                      ) : (
                        <Network className="size-3.5 text-text-muted" aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-[12px]">{item.name}</span>
                        {item.is_prod && (
                          <span className="rounded border border-danger/40 bg-danger/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-danger">
                            prod
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-text-muted">
                        {item.cluster} · {item.user}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-4 text-[12px] text-text-muted">
                No clusters match.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
