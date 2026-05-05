import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bell, Info, X } from "lucide-react";
import { useActivityStream, type ActivityEntry } from "@/state/activityStream";
import { cn } from "@/lib/utils";

/**
 * Cluster activity / pulse drawer
 * ───────────────────────────────
 *
 * Right-edge slide-out that streams cluster events live. Listed newest-first
 * with a colour-coded `type_` indicator. Filter chips along the top hide
 * Normal events when the user only wants to see Warnings.
 *
 * The bell button (rendered separately in the NavBar) opens this drawer and
 * marks unread Warnings as read.
 */

type Filter = "all" | "warning" | "normal";

function relativeTime(ts: string | null, now: number): string {
  if (!ts) return "—";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return ts;
  const ms = Math.max(0, now - t);
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function tonePalette(type_: string): {
  ringClass: string;
  Icon: typeof Bell;
  iconClass: string;
} {
  const lower = (type_ ?? "").toLowerCase();
  if (lower === "warning") {
    return {
      ringClass: "border-warning/40 bg-warning-soft",
      Icon: AlertTriangle,
      iconClass: "text-warning",
    };
  }
  return {
    ringClass: "border-border-subtle bg-elevated",
    Icon: Info,
    iconClass: "text-text-muted",
  };
}

function EntryRow({ entry, now }: { entry: ActivityEntry; now: number }) {
  const { ringClass, Icon, iconClass } = tonePalette(entry.type_);
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-control border px-2.5 py-1.5",
        ringClass,
      )}
    >
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", iconClass)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] font-mono">
          <span className="text-text-primary">{entry.reason}</span>
          <span className="text-text-muted">·</span>
          <span className="truncate text-text-muted" title={entry.involved}>
            {entry.involved}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-text-secondary" title={entry.message}>
          {entry.message}
        </div>
      </div>
      <span className="shrink-0 font-mono text-[10px] text-text-muted tabular-nums">
        {relativeTime(entry.ts, now)}
      </span>
    </li>
  );
}

export function ActivityDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const entries = useActivityStream((s) => s.entries);
  const streaming = useActivityStream((s) => s.streaming);
  const markRead = useActivityStream((s) => s.markRead);
  const [filter, setFilter] = useState<Filter>("all");
  // Refresh "Xs ago" labels every 5s while open — cheap, single setState.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    markRead();
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, [open, markRead]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const visible = useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((e) => (e.type_ ?? "").toLowerCase() === filter);
  }, [entries, filter]);

  const warningCount = useMemo(
    () => entries.filter((e) => (e.type_ ?? "").toLowerCase() === "warning").length,
    [entries],
  );

  if (!open) return null;
  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-label="Cluster activity"
        className="fixed right-0 top-0 z-50 flex h-full w-[360px] flex-col border-l border-border-default bg-surface shadow-[var(--shadow-popover)]"
      >
        <header className="flex items-center justify-between border-b border-border-default px-3 py-2">
          <div className="flex items-center gap-2">
            <Bell className="size-4 text-accent-primary" aria-hidden="true" />
            <span className="text-[13px] font-medium text-text-primary">Activity</span>
            <span
              className={cn(
                "size-1.5 rounded-full",
                streaming ? "bg-success animate-pulse" : "bg-text-muted",
              )}
              title={streaming ? "live" : "offline"}
              aria-hidden="true"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-elevated hover:text-text-primary"
            aria-label="close activity"
          >
            <X className="size-3.5" />
          </button>
        </header>
        <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-3 py-1.5">
          {(
            [
              { id: "all" as Filter, label: `all · ${entries.length}` },
              { id: "warning" as Filter, label: `warning · ${warningCount}` },
              {
                id: "normal" as Filter,
                label: `normal · ${entries.length - warningCount}`,
              },
            ]
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded-control px-2 py-0.5 text-[10px] font-mono transition-colors",
                filter === f.id
                  ? "bg-accent-primary-soft text-accent-primary"
                  : "text-text-muted hover:bg-hover hover:text-text-primary",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {visible.length === 0 ? (
            <div className="mt-6 text-center text-[12px] text-text-muted">
              {streaming
                ? "no events yet · streaming"
                : "no active stream · select a cluster context to start"}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {visible.map((entry) => (
                <EntryRow key={entry.id} entry={entry} now={now} />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}
