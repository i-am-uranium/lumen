import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  CheckCircle2,
  Clock3,
  ExternalLink,
  History,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  changeHistoryResourceHref,
  filterChangeHistoryEvents,
  type ChangeHistoryAction,
  type ChangeHistoryStatus,
} from "@/lib/changeHistory";
import { cn } from "@/lib/utils";
import { useChangeHistoryStore } from "@/state/changeHistory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type FilterState = {
  context: string;
  namespace: string;
  action: ChangeHistoryAction | "all";
  status: ChangeHistoryStatus | "all";
  search: string;
};

const ACTION_LABELS: Record<ChangeHistoryAction, string> = {
  apply: "apply",
  delete: "delete",
  restart: "restart",
  scale: "scale",
  "set-image": "set image",
  trigger: "trigger",
  "helm-install": "helm install",
  "helm-upgrade": "helm upgrade",
  "helm-rollback": "helm rollback",
  "helm-uninstall": "helm uninstall",
  "argocd-sync": "argocd sync",
  "argocd-rollback": "argocd rollback",
  "argocd-terminate": "argocd terminate",
};

const ACTIONS = Object.keys(ACTION_LABELS) as ChangeHistoryAction[];

export function ChangeHistoryView() {
  const { ctx = "" } = useParams();
  const decodedCtx = decodeURIComponent(ctx);
  const events = useChangeHistoryStore((s) => s.events);
  const clearEvents = useChangeHistoryStore((s) => s.clearEvents);
  const [filters, setFilters] = useState<FilterState>({
    context: decodedCtx,
    namespace: "",
    action: "all",
    status: "all",
    search: "",
  });

  const contexts = useMemo(
    () => unique(events.map((event) => event.target.context).filter(Boolean)),
    [events],
  );
  const namespaces = useMemo(
    () =>
      unique(
        events
          .filter((event) =>
            filters.context ? event.target.context === filters.context : true,
          )
          .map((event) => event.target.namespace)
          .filter(Boolean),
      ),
    [events, filters.context],
  );
  const visibleEvents = useMemo(
    () =>
      filterChangeHistoryEvents(events, {
        context: filters.context,
        namespace: filters.namespace,
        action: filters.action,
        status: filters.status,
        search: filters.search,
      }),
    [events, filters],
  );

  function updateFilters(patch: Partial<FilterState>) {
    setFilters((current) => ({ ...current, ...patch }));
  }

  function clearLocalHistory() {
    if (events.length === 0) return;
    if (!window.confirm("Clear local change history on this device?")) return;
    clearEvents();
  }

  return (
    <main className="h-full overflow-y-auto bg-bg-primary text-text-primary">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-6 py-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-text-muted">
              <History className="size-3.5" aria-hidden="true" />
              local audit trail
            </div>
            <h1 className="mds-heading text-[20px] text-text-primary">
              change history
            </h1>
            <p className="mt-1 max-w-2xl text-[12px] text-text-secondary">
              User-triggered mutating actions recorded by this Lumen app on this
              device. Kubernetes audit logs remain in the cluster.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={clearLocalHistory}
            disabled={events.length === 0}
            className="h-8 gap-2"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            clear local
          </Button>
        </header>

        <section className="grid gap-2 border-y border-border-default py-3 md:grid-cols-[minmax(180px,1fr)_minmax(150px,0.8fr)_minmax(150px,0.8fr)_minmax(120px,0.6fr)_minmax(220px,1.2fr)]">
          <SelectField
            label="context"
            value={filters.context}
            onChange={(context) => updateFilters({ context, namespace: "" })}
            options={contexts}
            allLabel="all contexts"
          />
          <SelectField
            label="namespace"
            value={filters.namespace}
            onChange={(namespace) => updateFilters({ namespace })}
            options={namespaces}
            allLabel="all namespaces"
          />
          <label className="flex flex-col gap-1">
            <span className="mds-label text-text-muted">action</span>
            <select
              value={filters.action}
              onChange={(event) =>
                updateFilters({
                  action: event.target.value as ChangeHistoryAction | "all",
                })
              }
              className="h-9 rounded-md border border-border-default bg-bg-secondary px-2 text-[12px] text-text-primary"
            >
              <option value="all">all actions</option>
              {ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABELS[action]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="mds-label text-text-muted">status</span>
            <select
              value={filters.status}
              onChange={(event) =>
                updateFilters({
                  status: event.target.value as ChangeHistoryStatus | "all",
                })
              }
              className="h-9 rounded-md border border-border-default bg-bg-secondary px-2 text-[12px] text-text-primary"
            >
              <option value="all">all statuses</option>
              <option value="success">success</option>
              <option value="failure">failure</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="mds-label text-text-muted">search</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" />
              <Input
                value={filters.search}
                onChange={(event) => updateFilters({ search: event.target.value })}
                placeholder="summary, target, error"
                className="h-9 pl-7 text-[12px]"
              />
            </div>
          </label>
        </section>

        <section className="min-h-[320px]">
          {events.length === 0 ? (
            <EmptyState
              title="No local changes recorded"
              body="Mutating actions you run from Lumen will appear here after they complete."
            />
          ) : visibleEvents.length === 0 ? (
            <EmptyState
              title="No matching changes"
              body="Adjust the filters to inspect a broader slice of local history."
            />
          ) : (
            <div className="overflow-hidden rounded-md border border-border-default">
              <table className="w-full table-fixed text-left text-[12px]">
                <thead className="border-b border-border-default bg-bg-secondary text-text-muted">
                  <tr>
                    <Th className="w-[150px]">time</Th>
                    <Th className="w-[120px]">status</Th>
                    <Th className="w-[150px]">action</Th>
                    <Th>target</Th>
                    <Th>summary</Th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEvents.map((event) => {
                    const href = changeHistoryResourceHref(event);
                    return (
                      <tr
                        key={event.id}
                        className="border-b border-border-subtle last:border-0 hover:bg-hover"
                      >
                        <Td>
                          <div className="flex items-center gap-1.5 text-text-secondary">
                            <Clock3 className="size-3.5" aria-hidden="true" />
                            <time dateTime={new Date(event.timestamp).toISOString()}>
                              {formatTimestamp(event.timestamp)}
                            </time>
                          </div>
                        </Td>
                        <Td>
                          <StatusPill status={event.status} />
                        </Td>
                        <Td>
                          <span className="rounded-[4px] border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
                            {ACTION_LABELS[event.action]}
                          </span>
                        </Td>
                        <Td>
                          <div className="min-w-0">
                            <div className="truncate font-mono text-text-primary">
                              {event.target.kind}/{event.target.name}
                            </div>
                            <div className="truncate font-mono text-[11px] text-text-muted">
                              {event.target.namespace || "cluster"} ·{" "}
                              {event.target.context || "current context"}
                            </div>
                          </div>
                        </Td>
                        <Td>
                          <div className="flex min-w-0 items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-text-secondary">
                                {event.summary}
                              </div>
                              {event.error && (
                                <div className="mt-1 truncate font-mono text-[11px] text-danger">
                                  {event.error}
                                </div>
                              )}
                            </div>
                            {href && (
                              <Link
                                to={href}
                                title="open affected resource"
                                className="shrink-0 rounded-[4px] p-1 text-text-muted hover:bg-hover hover:text-text-primary"
                              >
                                <ExternalLink className="size-3.5" aria-hidden="true" />
                              </Link>
                            )}
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  allLabel: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="mds-label text-text-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-border-default bg-bg-secondary px-2 text-[12px] text-text-primary"
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusPill({ status }: { status: ChangeHistoryStatus }) {
  const success = status === "success";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[4px] border px-1.5 py-0.5 text-[11px]",
        success
          ? "border-success/40 bg-success-soft text-success"
          : "border-danger/40 bg-danger-soft text-danger",
      )}
    >
      {success ? (
        <CheckCircle2 className="size-3" aria-hidden="true" />
      ) : (
        <XCircle className="size-3" aria-hidden="true" />
      )}
      {status}
    </span>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center rounded-md border border-dashed border-border-default px-4 text-center">
      <History className="mb-3 size-8 text-text-muted" aria-hidden="true" />
      <h2 className="mds-heading text-[15px] text-text-primary">{title}</h2>
      <p className="mt-1 max-w-md text-[12px] text-text-secondary">{body}</p>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <th className={cn("px-3 py-2 font-medium uppercase tracking-wide", className)}>
      {children}
    </th>
  );
}

function Td({ children }: { children: ReactNode }) {
  return <td className="min-w-0 px-3 py-2 align-top">{children}</td>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
