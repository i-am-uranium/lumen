import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArchiveRestore,
  ChevronDown,
  CircleDot,
  Cpu,
  MemoryStick,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { k8s, type ContextInfo, type DeletedContextSummary, type FleetCard } from "@/lib/k8s";
import { cn } from "@/lib/utils";

function pct(n: number | null): string {
  if (n === null) return "—";
  return `${Math.round(n)}%`;
}

function heatBand(n: number | null): string {
  if (n === null) return "bg-term-panel-2";
  if (n < 50) return "bg-emerald-500/70";
  if (n < 75) return "bg-term-green/80";
  if (n < 90) return "bg-amber-400";
  return "bg-term-red";
}

function fleetRiskScore(card: FleetCard): number {
  if (!card.reachable) return 0;
  if (card.context.is_prod && card.health.pods_failed > 0) return 1;
  if (card.health.pods_failed > 0) return 2;
  if ((card.cpu_percent ?? 0) >= 90 || (card.mem_percent ?? 0) >= 90) return 3;
  if (card.health.pods_pending > 0) return 4;
  return 5;
}

type FleetEntry = {
  context: ContextInfo;
  card?: FleetCard;
  connecting: boolean;
};

const FLEET_CARDS_STORAGE_KEY = "lumen:fleet:connected-cards";
const FLEET_HIDDEN_STORAGE_KEY = "lumen:fleet:hidden-contexts";
const FLEET_LABELS_STORAGE_KEY = "lumen:fleet:cluster-labels";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(err);
}

function readStoredCards(): Record<string, FleetCard> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(FLEET_CARDS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, FleetCard>)
      : {};
  } catch {
    return {};
  }
}

function writeStoredCards(cards: Record<string, FleetCard>): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(cards).length === 0) {
      window.sessionStorage.removeItem(FLEET_CARDS_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(FLEET_CARDS_STORAGE_KEY, JSON.stringify(cards));
    }
  } catch {
    // storage is an optimization; ignore quota/private-mode failures.
  }
}

function readStoredHidden(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.sessionStorage.getItem(FLEET_HIDDEN_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((name): name is string => typeof name === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeStoredHidden(hidden: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (hidden.size === 0) {
      window.sessionStorage.removeItem(FLEET_HIDDEN_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(FLEET_HIDDEN_STORAGE_KEY, JSON.stringify([...hidden]));
    }
  } catch {
    // storage is an optimization; ignore quota/private-mode failures.
  }
}

function readStoredLabels(): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(FLEET_LABELS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([name, labels]) => [
          name,
          Array.isArray(labels)
            ? labels.filter((label): label is string => typeof label === "string")
            : [],
        ])
        .filter(([, labels]) => labels.length > 0),
    );
  } catch {
    return {};
  }
}

function writeStoredLabels(labels: Record<string, string[]>): void {
  if (typeof window === "undefined") return;
  try {
    const compact = Object.fromEntries(
      Object.entries(labels).filter(([, values]) => values.length > 0),
    );
    if (Object.keys(compact).length === 0) {
      window.localStorage.removeItem(FLEET_LABELS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(FLEET_LABELS_STORAGE_KEY, JSON.stringify(compact));
    }
  } catch {
    // Labels are local UI metadata; ignore quota/private-mode failures.
  }
}

function entryRiskScore(entry: FleetEntry): number {
  if (entry.card) return fleetRiskScore(entry.card);
  if (entry.connecting) return 6;
  return 7;
}

function HeatBar({ value, label, icon }: { value: number | null; label: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-term-subtle shrink-0">{icon}</span>
      <span className="text-[11px] text-term-muted shrink-0 w-7">{label}</span>
      <div className="flex-1 h-1.5 bg-term-panel-2 rounded-full overflow-hidden min-w-[40px]">
        <div
          className={cn("h-full transition-all", heatBand(value))}
          style={{ width: `${value === null ? 0 : Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
      <span className="text-[11px] text-term-fg w-10 text-right tabular-nums">{pct(value)}</span>
    </div>
  );
}

function PodRatioRing({ card }: { card: FleetCard }) {
  const { pods_total, pods_ready, pods_pending, pods_failed } = card.health;
  const total = Math.max(1, pods_total);
  const readyPct = (pods_ready / total) * 100;
  const pendingPct = (pods_pending / total) * 100;
  const failedPct = (pods_failed / total) * 100;
  const r = 22;
  const circ = 2 * Math.PI * r;
  const seg = (p: number) => (p / 100) * circ;
  return (
    <div className="relative w-[68px] h-[68px] shrink-0">
      <svg viewBox="0 0 60 60" className="w-full h-full -rotate-90">
        <circle cx="30" cy="30" r={r} stroke="var(--term-panel-2)" strokeWidth="6" fill="none" />
        <circle
          cx="30"
          cy="30"
          r={r}
          stroke="var(--term-red)"
          strokeWidth="6"
          fill="none"
          strokeDasharray={`${seg(failedPct)} ${circ}`}
          strokeDashoffset={0}
          strokeLinecap="round"
        />
        <circle
          cx="30"
          cy="30"
          r={r}
          stroke="#fbbf24"
          strokeWidth="6"
          fill="none"
          strokeDasharray={`${seg(pendingPct)} ${circ}`}
          strokeDashoffset={-seg(failedPct)}
          strokeLinecap="round"
        />
        <circle
          cx="30"
          cy="30"
          r={r}
          stroke="#10b981"
          strokeWidth="6"
          fill="none"
          strokeDasharray={`${seg(readyPct)} ${circ}`}
          strokeDashoffset={-(seg(failedPct) + seg(pendingPct))}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-[13px] font-semibold text-term-fg tabular-nums leading-none">
          {pods_ready}
        </span>
        <span className="text-[9px] text-term-subtle tabular-nums">/{pods_total}</span>
      </div>
    </div>
  );
}

function Card({
  entry,
  labels,
  onOpen,
  onConnect,
  onDisconnect,
  onDelete,
  onAddLabel,
  onRemoveLabel,
}: {
  entry: FleetEntry;
  labels: string[];
  onOpen: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onDelete: () => void;
  onAddLabel: (label: string) => void;
  onRemoveLabel: (label: string) => void;
}) {
  const { context, card, connecting } = entry;
  if (!card) {
    return (
      <article
        data-testid="fleet-card"
        className="text-left flex flex-col gap-3 p-4 rounded-lg border transition-all min-h-[214px] justify-between bg-term-panel border-term-border-soft"
      >
        <div className="flex items-start gap-3">
          <div className="size-2 rounded-full mt-1.5 shrink-0 bg-term-subtle" />
          <div className="flex-1 min-w-0">
            <button
              type="button"
              onClick={onOpen}
              className={cn(
                "block max-w-full text-[14px] font-semibold text-term-fg truncate text-left",
                "hover:text-term-green focus:outline-none focus-visible:ring-2 focus-visible:ring-term-green/60 rounded-sm",
              )}
            >
              {context.name}
            </button>
            <div className="text-[11px] text-term-subtle truncate mt-0.5">
              {context.cluster} · {context.user}
            </div>
          </div>
        </div>

        <div className="rounded border border-term-border-soft bg-term-bg/40 p-3">
          <div className="text-[10px] uppercase tracking-wider text-term-subtle">status</div>
          <div className="mt-1 text-[13px] text-term-fg">
            {connecting ? "connecting..." : "not connected"}
          </div>
          <div className="mt-1 text-[11px] text-term-muted">live metrics paused</div>
        </div>

        <ClusterLabels
          contextName={context.name}
          labels={labels}
          onAdd={onAddLabel}
          onRemove={onRemoveLabel}
        />

        <div className="grid grid-cols-[1fr_auto] gap-3 pt-2 border-t border-term-border-soft">
          <div data-testid="fleet-card-workflow-actions" className="flex items-center">
            <button
              type="button"
              onClick={onConnect}
              disabled={connecting}
              aria-label={`connect ${context.name}`}
              className="term-btn !min-h-[30px] !py-1 !px-3 !text-[12px]"
            >
              <RefreshCw className={cn("size-3.5", connecting && "animate-spin")} />
              {connecting ? "connecting" : "connect"}
            </button>
          </div>
          <div
            data-testid="fleet-card-danger-actions"
            className="flex items-center border-l border-term-border-soft pl-3"
          >
            <button
              type="button"
              onClick={onDelete}
              aria-label={`delete ${context.name}`}
              className="term-btn !min-h-[30px] !py-1 !px-3 !text-[12px] text-term-muted hover:border-term-red/50 hover:text-term-red"
            >
              delete
            </button>
          </div>
        </div>
      </article>
    );
  }

  const unreachable = !card.reachable;
  const isProd = card.context.is_prod;
  return (
    <article
      data-testid="fleet-card"
      className={cn(
        "text-left group relative flex flex-col gap-3 p-4 rounded-lg border transition-all min-h-[214px] justify-between",
        "bg-term-panel hover:bg-term-panel-2 border-term-border-soft",
        "hover:border-term-green/60",
        unreachable && "opacity-75 hover:border-term-border-soft",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "size-2 rounded-full mt-1.5 shrink-0",
            unreachable ? "bg-term-red" : "bg-emerald-400 animate-pulse",
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={onOpen}
              disabled={unreachable}
              className={cn(
                "text-[14px] font-semibold text-term-fg truncate text-left",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-term-green/60 rounded-sm",
                unreachable && "cursor-not-allowed",
              )}
            >
              {card.context.name}
            </button>
            {isProd && (
              <span className="px-1.5 py-0.5 text-[10px] rounded bg-term-red/20 text-term-red border border-term-red/40 font-semibold uppercase tracking-wide">
                prod
              </span>
            )}
            {card.server_version && (
              <span className="text-[11px] text-term-subtle tabular-nums">
                {card.server_version}
              </span>
            )}
          </div>
          <div className="text-[11px] text-term-subtle truncate mt-0.5">
            {card.context.cluster} · {card.context.user}
          </div>
        </div>
        {!unreachable && <PodRatioRing card={card} />}
      </div>

      {unreachable ? (
        <div className="flex items-start gap-2 p-2 rounded bg-term-red/10 border border-term-red/30 text-[12px] text-term-red">
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{card.error ?? "unreachable"}</span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 text-[12px]">
            <div className="flex flex-col">
              <span className="text-term-subtle text-[10px] uppercase tracking-wider">nodes</span>
              <span className="text-term-fg tabular-nums">
                <span className={card.node_ready < card.node_count ? "text-amber-400" : ""}>
                  {card.node_ready}
                </span>
                <span className="text-term-subtle">/{card.node_count}</span>
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-term-subtle text-[10px] uppercase tracking-wider">ns</span>
              <span className="text-term-fg tabular-nums">{card.namespace_count}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-term-subtle text-[10px] uppercase tracking-wider">workloads</span>
              <span className="text-term-fg tabular-nums">{card.workload_count}</span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <HeatBar value={card.cpu_percent} label="cpu" icon={<Cpu className="size-3" />} />
            <HeatBar value={card.mem_percent} label="mem" icon={<MemoryStick className="size-3" />} />
          </div>
        </>
      )}

      <ClusterLabels
        contextName={context.name}
        labels={labels}
        onAdd={onAddLabel}
        onRemove={onRemoveLabel}
      />

      <div className="pt-2 border-t border-term-border-soft text-[11px] text-term-subtle">
        <div className="flex items-center gap-1">
          <CircleDot className="size-3" />
          <span className="tabular-nums">
            {new Date(card.fetched_at_ms).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-[1fr_auto_auto] gap-3 items-center">
          <div data-testid="fleet-card-workflow-actions" className="flex items-center">
            {unreachable ? (
              <span className="text-[11px] text-term-muted">triage unavailable</span>
            ) : (
              <button
                type="button"
                onClick={onOpen}
                aria-label={`triage ${context.name}`}
                className={cn(
                  "term-btn !min-h-[30px] !py-1 !px-4 !text-[12px]",
                  "border-term-green/50 bg-term-green/15 text-term-green",
                  "hover:border-term-green hover:bg-term-green/20 hover:text-term-fg",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-term-green/60",
                )}
              >
                triage
              </button>
            )}
          </div>
          <div data-testid="fleet-card-connection-actions" className="flex items-center">
            {unreachable ? (
              <button
                type="button"
                onClick={onConnect}
                disabled={connecting}
                aria-label={`connect ${context.name}`}
                className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px]"
              >
                <RefreshCw className={cn("size-3", connecting && "animate-spin")} />
                retry
              </button>
            ) : (
              <button
                type="button"
                onClick={onDisconnect}
                aria-label={`disconnect ${context.name}`}
                className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px]"
              >
                disconnect
              </button>
            )}
          </div>
          <div
            data-testid="fleet-card-danger-actions"
            className="flex items-center border-l border-term-border-soft pl-3"
          >
            <button
              type="button"
              onClick={onDelete}
              aria-label={`delete ${context.name}`}
              className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px] text-term-muted hover:border-term-red/50 hover:text-term-red"
            >
              delete
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function ClusterLabels({
  contextName,
  labels,
  onAdd,
  onRemove,
}: {
  contextName: string;
  labels: string[];
  onAdd: (label: string) => void;
  onRemove: (label: string) => void;
}) {
  const [draft, setDraft] = useState("");

  function submit() {
    const value = draft.trim();
    if (!value) return;
    onAdd(value);
    setDraft("");
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {labels.map((label) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 rounded border border-term-border-soft bg-term-bg/40 px-1.5 py-0.5 text-[10px] text-term-muted"
        >
          <Tag className="size-2.5" aria-hidden="true" />
          {label}
          <button
            type="button"
            onClick={() => onRemove(label)}
            aria-label={`remove ${label} label from ${contextName}`}
            className="text-term-subtle hover:text-term-red"
          >
            <X className="size-2.5" aria-hidden="true" />
          </button>
        </span>
      ))}
      <div className="inline-flex items-center gap-1 rounded border border-term-border-soft bg-term-bg/40 px-1.5 py-0.5">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              submit();
            }
          }}
          aria-label={`add label to ${contextName}`}
          placeholder="label"
          className="w-[64px] bg-transparent text-[10px] text-term-fg placeholder:text-term-subtle focus:outline-none"
        />
        <button
          type="button"
          onClick={submit}
          aria-label={`save label for ${contextName}`}
          className="text-term-subtle hover:text-term-green"
        >
          <Plus className="size-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function FleetView() {
  const nav = useNavigate();
  const [cardsByContext, setCardsByContext] = useState<Record<string, FleetCard>>(
    readStoredCards,
  );
  const [connecting, setConnecting] = useState<Set<string>>(() => new Set());
  const [hidden, setHidden] = useState<Set<string>>(readStoredHidden);
  const [labelsByContext, setLabelsByContext] = useState<Record<string, string[]>>(
    readStoredLabels,
  );
  const [trashOpen, setTrashOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ContextInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<DeletedContextSummary | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const { data: contexts = [], isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["k8s", "contexts"],
    queryFn: k8s.listContexts,
    staleTime: 5_000,
  });
  const {
    data: deletedContexts = [],
    isFetching: isTrashFetching,
    refetch: refetchDeletedContexts,
  } = useQuery({
    queryKey: ["k8s", "deleted-contexts"],
    queryFn: k8s.listDeletedContexts,
    staleTime: 5_000,
  });

  const sorted = useMemo(() => {
    return contexts
      .filter((context) => !hidden.has(context.name))
      .map((context) => ({
        context,
        card: cardsByContext[context.name],
        connecting: connecting.has(context.name),
      }))
      .sort((a, b) => {
        const risk = entryRiskScore(a) - entryRiskScore(b);
        if (risk !== 0) return risk;
        if (a.context.is_prod !== b.context.is_prod) return a.context.is_prod ? -1 : 1;
        return a.context.name.localeCompare(b.context.name);
      });
  }, [cardsByContext, connecting, contexts, hidden]);

  const cards = sorted.flatMap((entry) => (entry.card ? [entry.card] : []));
  const reach = cards.filter((c) => c.reachable);
  const riskTotals = useMemo(
    () => ({
      connected: cards.length,
      disconnected: sorted.filter((entry) => !entry.card).length,
      unreachable: cards.filter((c) => !c.reachable).length,
      prodAlerts: reach.filter((c) => c.context.is_prod && c.health.pods_failed > 0).length,
      pressure: reach.filter(
        (c) => (c.cpu_percent ?? 0) >= 90 || (c.mem_percent ?? 0) >= 90,
      ).length,
    }),
    [cards, reach, sorted],
  );

  useEffect(() => {
    writeStoredCards(cardsByContext);
  }, [cardsByContext]);

  useEffect(() => {
    writeStoredHidden(hidden);
  }, [hidden]);

  useEffect(() => {
    writeStoredLabels(labelsByContext);
  }, [labelsByContext]);

  function addLabel(contextName: string, label: string) {
    const normalized = label.trim().replace(/\s+/g, "-").toLowerCase();
    if (!normalized) return;
    setLabelsByContext((prev) => {
      const existing = prev[contextName] ?? [];
      if (existing.includes(normalized)) return prev;
      return { ...prev, [contextName]: [...existing, normalized] };
    });
  }

  function removeLabel(contextName: string, label: string) {
    setLabelsByContext((prev) => {
      const nextLabels = (prev[contextName] ?? []).filter((value) => value !== label);
      const next = { ...prev };
      if (nextLabels.length === 0) {
        delete next[contextName];
      } else {
        next[contextName] = nextLabels;
      }
      return next;
    });
  }

  async function connectContext(contextName: string) {
    setConnecting((prev) => new Set(prev).add(contextName));
    try {
      const card = await k8s.probeFleetContext(contextName);
      setCardsByContext((prev) => ({ ...prev, [contextName]: card }));
    } finally {
      setConnecting((prev) => {
        const next = new Set(prev);
        next.delete(contextName);
        return next;
      });
    }
  }

  async function disconnectContext(contextName: string) {
    await k8s.disconnectContext(contextName);
    setCardsByContext((prev) => {
      const next = { ...prev };
      delete next[contextName];
      return next;
    });
  }

  async function deleteContext(contextName: string) {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await k8s.deleteContext(contextName);
      setHidden((prev) => new Set(prev).add(contextName));
      setCardsByContext((prev) => {
        const next = { ...prev };
        delete next[contextName];
        return next;
      });
      await refetchDeletedContexts();
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function restoreContext(contextName: string, overwrite = false) {
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      await k8s.restoreDeletedContext(contextName, overwrite);
      setHidden((prev) => {
        const next = new Set(prev);
        next.delete(contextName);
        return next;
      });
      await Promise.all([refetch(), refetchDeletedContexts()]);
      setRestoreTarget(null);
    } catch (err) {
      setRestoreError(errorMessage(err));
      if (!overwrite) {
        const target = deletedContexts.find((context) => context.name === contextName);
        if (target) setRestoreTarget({ ...target, has_conflict: true });
      }
    } finally {
      setRestoreBusy(false);
    }
  }

  async function rescan() {
    setHidden(new Set());
    await Promise.all([refetch(), refetchDeletedContexts()]);
  }

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-term-bg/95 backdrop-blur border-b border-term-border-soft">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <h1 className="mds-heading text-[20px] text-term-fg">fleet</h1>
            <p className="text-[12px] text-term-muted">
              {sorted.length} context{sorted.length === 1 ? "" : "s"} ·{" "}
              {cards.length} connected
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={rescan}
              className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
              disabled={isFetching}
              title="Scan local kubeconfig contexts and restore removed clusters."
            >
              <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
              rescan
            </button>
          </div>
        </div>
        {sorted.length > 0 && (
          <div className="grid grid-cols-5 gap-0 border-t border-term-border-soft">
            <Stat
              icon={<Server className="size-3.5" />}
              label="connected"
              value={riskTotals.connected}
              tone={riskTotals.connected > 0 ? "good" : undefined}
            />
            <Stat
              icon={<CircleDot className="size-3.5" />}
              label="offline"
              value={riskTotals.disconnected}
            />
            <Stat
              icon={<AlertTriangle className="size-3.5" />}
              label="unreachable"
              value={riskTotals.unreachable}
              tone={riskTotals.unreachable > 0 ? "bad" : undefined}
            />
            <Stat
              icon={<ShieldAlert className="size-3.5" />}
              label="prod alerts"
              value={riskTotals.prodAlerts}
              tone={riskTotals.prodAlerts > 0 ? "bad" : undefined}
            />
            <Stat
              icon={<Cpu className="size-3.5" />}
              label="pressure"
              value={riskTotals.pressure}
              tone={riskTotals.pressure > 0 ? "bad" : undefined}
            />
          </div>
        )}
      </div>

      <div className="p-6">
        {error ? (
          <div className="rounded-lg border border-term-red/40 bg-term-red/10 p-4 text-[13px] text-term-red">
            {(error as Error).message}
          </div>
        ) : isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-[200px] rounded-lg border border-term-border-soft bg-term-panel animate-pulse"
              />
            ))}
          </div>
        ) : (
          <>
            {sorted.length === 0 ? (
              <div className="text-[13px] text-term-muted">no active contexts in kubeconfig.</div>
            ) : (
              <div data-testid="fleet-card-grid" className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {sorted.map((entry) => (
                  <Card
                    key={entry.context.name}
                    entry={entry}
                    labels={labelsByContext[entry.context.name] ?? []}
                    onOpen={() => nav(`/cluster/${encodeURIComponent(entry.context.name)}/workloads`)}
                    onConnect={() => connectContext(entry.context.name)}
                    onDisconnect={() => disconnectContext(entry.context.name)}
                    onDelete={() => {
                      setDeleteError(null);
                      setDeleteTarget(entry.context);
                    }}
                    onAddLabel={(label) => addLabel(entry.context.name, label)}
                    onRemoveLabel={(label) => removeLabel(entry.context.name, label)}
                  />
                ))}
              </div>
            )}
            <TrashSection
              contexts={deletedContexts}
              busy={isTrashFetching || restoreBusy}
              open={trashOpen}
              onOpenChange={setTrashOpen}
              onRestore={(context) => {
                setRestoreError(null);
                if (context.has_conflict) {
                  setRestoreTarget(context);
                } else {
                  void restoreContext(context.name);
                }
              }}
            />
          </>
        )}
      </div>
      {deleteTarget && (
        <DeleteContextDialog
          context={deleteTarget}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void deleteContext(deleteTarget.name)}
        />
      )}
      {restoreTarget && (
        <RestoreContextDialog
          context={restoreTarget}
          busy={restoreBusy}
          error={restoreError}
          onCancel={() => setRestoreTarget(null)}
          onRestore={() => void restoreContext(restoreTarget.name, true)}
        />
      )}
    </div>
  );
}

function TrashSection({
  contexts,
  busy,
  open,
  onOpenChange,
  onRestore,
}: {
  contexts: DeletedContextSummary[];
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: (context: DeletedContextSummary) => void;
}) {
  if (contexts.length === 0) return null;
  return (
    <section className="mt-6 border-t border-term-border-soft pt-4">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-md px-1 py-1 text-left hover:bg-term-panel/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-term-green/60"
      >
        <div className="flex items-center gap-2">
          <Trash2 className="size-4 text-term-subtle" />
          <h2 className="text-[13px] font-semibold text-term-fg">trash</h2>
          <span className="text-[11px] text-term-muted">
            {contexts.length} deleted · kept for 90 days
          </span>
        </div>
        <ChevronDown
          className={cn("size-4 text-term-subtle transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && <div className="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {contexts.map((context) => (
          <article
            key={context.name}
            className="rounded-lg border border-term-border-soft bg-term-panel/60 p-3"
          >
            <div className="flex items-start gap-2">
              <div className="size-2 rounded-full mt-1.5 bg-term-muted shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="truncate text-[13px] font-semibold text-term-fg">
                    {context.name}
                  </div>
                  {context.is_prod && (
                    <span className="px-1.5 py-0.5 text-[9px] rounded bg-term-red/20 text-term-red border border-term-red/40 font-semibold uppercase tracking-wide">
                      prod
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-term-muted">
                  {context.cluster} · {context.user}
                </div>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-term-border-soft pt-3">
              <div className="text-[11px] text-term-subtle">
                expires in {context.days_remaining}d
                {context.has_conflict && (
                  <span className="ml-2 text-amber-400">conflict</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRestore(context)}
                disabled={busy}
                aria-label={`restore ${context.name}`}
                className="term-btn !min-h-[28px] !py-1 !px-2 !text-[11px]"
              >
                <ArchiveRestore className="size-3" />
                restore
              </button>
            </div>
          </article>
        ))}
      </div>}
    </section>
  );
}

function DeleteContextDialog({
  context,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  context: ContextInfo;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-context-title"
        className="w-full max-w-[420px] rounded-lg border border-term-border bg-term-panel shadow-2xl"
      >
        <div className="p-4 border-b border-term-border-soft">
          <h2 id="delete-context-title" className="text-[15px] font-semibold text-term-fg">
            delete cluster from fleet?
          </h2>
          <p className="mt-1 text-[12px] text-term-muted">
            This moves the context to trash for 90 days, then removes it from your local kubeconfig.
            You can restore it from trash unless the backup expires.
          </p>
        </div>
        <div className="p-4 space-y-3">
          <div className="rounded border border-term-border-soft bg-term-bg/40 p-3">
            <div className="text-[10px] uppercase tracking-wider text-term-subtle">target</div>
            <div className="mt-1 text-[13px] text-term-fg font-mono break-all">{context.name}</div>
            <div className="mt-1 text-[11px] text-term-muted break-all">
              {context.cluster} · {context.user}
            </div>
          </div>
          {error && (
            <div className="rounded border border-term-red/40 bg-term-red/10 p-2 text-[12px] text-term-red">
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
            >
              cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px] text-term-red hover:border-term-red/60"
            >
              {busy ? "deleting..." : "delete"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RestoreContextDialog({
  context,
  busy,
  error,
  onCancel,
  onRestore,
}: {
  context: DeletedContextSummary;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onRestore: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="restore-context-title"
        className="w-full max-w-[440px] rounded-lg border border-term-border bg-term-panel shadow-2xl"
      >
        <div className="p-4 border-b border-term-border-soft">
          <h2 id="restore-context-title" className="text-[15px] font-semibold text-term-fg">
            restore deleted cluster?
          </h2>
          <p className="mt-1 text-[12px] text-term-muted">
            A context, cluster, or user with the same name is already present. Restore can override
            the current kubeconfig entries with the trash backup.
          </p>
        </div>
        <div className="p-4 space-y-3">
          <div className="rounded border border-term-border-soft bg-term-bg/40 p-3">
            <div className="text-[10px] uppercase tracking-wider text-term-subtle">backup</div>
            <div className="mt-1 text-[13px] text-term-fg font-mono break-all">{context.name}</div>
            <div className="mt-1 text-[11px] text-term-muted break-all">
              {context.cluster} · {context.user}
            </div>
          </div>
          {error && (
            <div className="rounded border border-term-red/40 bg-term-red/10 p-2 text-[12px] text-term-red">
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
            >
              keep current
            </button>
            <button
              type="button"
              onClick={onRestore}
              disabled={busy}
              className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px] text-amber-300 hover:border-amber-300/60"
            >
              {busy ? "restoring..." : "override and restore"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "good" | "bad";
}) {
  return (
    <div className="flex items-center gap-2 px-6 py-2.5 border-r border-term-border-soft last:border-r-0">
      <span className="text-term-subtle">{icon}</span>
      <div className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wider text-term-subtle">{label}</span>
        <span
          className={cn(
            "text-[14px] font-semibold tabular-nums",
            tone === "good" && "text-emerald-400",
            tone === "bad" && "text-term-red",
            !tone && "text-term-fg",
          )}
        >
          {value}
        </span>
      </div>
    </div>
  );
}
