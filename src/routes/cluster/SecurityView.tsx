import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertOctagon,
  AlertTriangle,
  CircleDot,
  Info,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { k8s, type Finding, type Severity } from "@/lib/k8s";
import { cn } from "@/lib/utils";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

const SEV_COLOR: Record<Severity, { bg: string; border: string; text: string; fill: string }> = {
  critical: {
    bg: "bg-red-500/10",
    border: "border-red-500/40",
    text: "text-red-400",
    fill: "bg-red-500",
  },
  high: {
    bg: "bg-orange-500/10",
    border: "border-orange-500/40",
    text: "text-orange-400",
    fill: "bg-orange-500",
  },
  medium: {
    bg: "bg-amber-500/10",
    border: "border-amber-500/40",
    text: "text-amber-400",
    fill: "bg-amber-500",
  },
  low: {
    bg: "bg-blue-500/10",
    border: "border-blue-500/40",
    text: "text-blue-400",
    fill: "bg-blue-500",
  },
  info: {
    bg: "bg-slate-500/10",
    border: "border-slate-500/40",
    text: "text-slate-400",
    fill: "bg-slate-500",
  },
};

function sevIcon(s: Severity) {
  if (s === "critical") return <AlertOctagon className="size-3.5" />;
  if (s === "high") return <ShieldAlert className="size-3.5" />;
  if (s === "medium") return <AlertTriangle className="size-3.5" />;
  if (s === "low") return <CircleDot className="size-3.5" />;
  return <Info className="size-3.5" />;
}

export function SecurityView() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["k8s", "security", context],
    queryFn: () => k8s.securityScan(context || undefined),
    staleTime: 30_000,
  });

  const [query, setQuery] = useState("");
  const [active, setActive] = useState<Set<Severity>>(
    new Set<Severity>(["critical", "high", "medium"]),
  );
  const [expandedRule, setExpandedRule] = useState<string | null>(null);

  const findings = data?.findings ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return findings.filter(
      (f) =>
        active.has(f.severity) &&
        (!q ||
          f.title.toLowerCase().includes(q) ||
          f.resource_name.toLowerCase().includes(q) ||
          f.rule_id.toLowerCase().includes(q) ||
          (f.namespace ?? "").toLowerCase().includes(q)),
    );
  }, [findings, query, active]);

  const grouped = useMemo(() => {
    const m = new Map<string, Finding[]>();
    for (const f of filtered) {
      if (!m.has(f.rule_id)) m.set(f.rule_id, []);
      m.get(f.rule_id)!.push(f);
    }
    return Array.from(m.entries()).sort(([, a], [, b]) => {
      const sevOrder = (s: Severity) => SEVERITIES.indexOf(s);
      return sevOrder(a[0].severity) - sevOrder(b[0].severity);
    });
  }, [filtered]);

  const score = useMemo(() => {
    if (!data) return 100;
    const weights: Record<Severity, number> = {
      critical: 25,
      high: 10,
      medium: 3,
      low: 1,
      info: 0,
    };
    const total = findings.reduce((s, f) => s + weights[f.severity], 0);
    return Math.max(0, 100 - Math.min(100, total));
  }, [data, findings]);

  const toggleSev = (s: Severity) => {
    const n = new Set(active);
    if (n.has(s)) n.delete(s);
    else n.add(s);
    setActive(n);
  };

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-term-bg/95 backdrop-blur border-b border-term-border-soft">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <h1 className="mds-heading text-[20px] text-term-fg flex items-center gap-2">
              <ShieldAlert className="size-5" /> devsec
            </h1>
            <p className="text-[12px] text-term-muted">
              {context} · {data?.resources_scanned ?? 0} resources scanned ·{" "}
              {data ? new Date(data.scanned_at_ms).toLocaleTimeString() : "—"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ScoreBadge score={score} />
            <button
              onClick={() => refetch()}
              className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
              disabled={isFetching}
            >
              <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
              rescan
            </button>
          </div>
        </div>
        <div className="grid grid-cols-5 border-t border-term-border-soft">
          {SEVERITIES.map((s) => {
            const count = data?.counts_by_severity?.[s] ?? 0;
            const on = active.has(s);
            return (
              <button
                key={s}
                onClick={() => toggleSev(s)}
                className={cn(
                  "flex items-center gap-3 px-6 py-3 border-r border-term-border-soft last:border-r-0 text-left transition-colors",
                  on ? SEV_COLOR[s].bg : "hover:bg-term-panel-2",
                )}
              >
                <span className={cn("shrink-0", SEV_COLOR[s].text)}>{sevIcon(s)}</span>
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-term-subtle">{s}</span>
                  <span
                    className={cn(
                      "text-[16px] font-semibold tabular-nums",
                      on ? SEV_COLOR[s].text : "text-term-fg",
                    )}
                  >
                    {count}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 px-6 py-3 border-t border-term-border-soft">
          <div className="flex items-center gap-2 h-8 px-2 rounded-md bg-term-bg border border-term-border-soft flex-1 max-w-md">
            <Search className="size-3.5 text-term-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by rule, resource, or namespace..."
              className="flex-1 bg-transparent outline-none text-[12px] text-term-fg placeholder:text-term-subtle"
            />
          </div>
          <span className="text-[11px] text-term-subtle">
            {filtered.length} of {findings.length} shown
          </span>
        </div>
      </div>

      <div className="p-6 space-y-3">
        {error ? (
          <div className="rounded-lg border border-term-red/40 bg-term-red/10 p-4 text-[13px] text-term-red">
            {(error as Error).message}
          </div>
        ) : isLoading ? (
          <div className="text-[13px] text-term-muted flex items-center gap-2">
            <RefreshCw className="size-4 animate-spin" />
            scanning cluster...
          </div>
        ) : grouped.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <ShieldCheck className="size-10 text-emerald-400 mb-3" />
            <p className="text-[14px] text-term-fg">no findings for the active filters.</p>
            <p className="text-[12px] text-term-muted mt-1">
              Enable lower severities above to see less urgent issues.
            </p>
          </div>
        ) : (
          grouped.map(([ruleId, group]) => {
            const sev = group[0].severity;
            const expanded = expandedRule === ruleId;
            return (
              <div
                key={ruleId}
                className={cn(
                  "rounded-lg border",
                  SEV_COLOR[sev].border,
                  SEV_COLOR[sev].bg,
                )}
              >
                <button
                  onClick={() => setExpandedRule(expanded ? null : ruleId)}
                  className="w-full flex items-start gap-3 p-4 text-left"
                >
                  <span className={cn("shrink-0 mt-0.5", SEV_COLOR[sev].text)}>
                    {sevIcon(sev)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={cn("text-[11px] font-mono uppercase tracking-wide", SEV_COLOR[sev].text)}>
                        {sev}
                      </span>
                      <span className="text-[11px] text-term-subtle font-mono">{ruleId}</span>
                      <span className="text-[11px] text-term-subtle">·</span>
                      <span className="text-[11px] text-term-subtle">{group[0].category}</span>
                    </div>
                    <div className="mt-1 text-[13px] text-term-fg">
                      {group[0].title.replace(/ '.*'/, "")}
                    </div>
                    <div className="mt-0.5 text-[12px] text-term-muted">
                      {group.length} affected resource{group.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  {expanded ? (
                    <ChevronDown className="size-4 text-term-subtle mt-1" />
                  ) : (
                    <ChevronRight className="size-4 text-term-subtle mt-1" />
                  )}
                </button>
                {expanded && (
                  <div className="px-4 pb-4">
                    <div className="mb-3 p-3 rounded bg-term-panel border border-term-border-soft text-[12px] text-term-muted">
                      <div className="text-[10px] uppercase tracking-wider text-term-subtle mb-1">
                        remediation
                      </div>
                      {group[0].remediation}
                    </div>
                    <div className="space-y-1.5">
                      {group.map((f, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-3 p-2 rounded border border-term-border-soft bg-term-panel/60 text-[12px]"
                        >
                          <span className="text-term-subtle font-mono w-[86px] shrink-0 uppercase text-[10px]">
                            {f.resource_kind}
                          </span>
                          <span className="text-term-fg shrink-0">{f.resource_name}</span>
                          {f.namespace && (
                            <span className="text-term-subtle">· ns/{f.namespace}</span>
                          )}
                          <span className="flex-1 text-term-muted truncate" title={f.detail}>
                            {f.detail}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const tone = score >= 90 ? "good" : score >= 70 ? "ok" : score >= 50 ? "warn" : "bad";
  const cls =
    tone === "good"
      ? "text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
      : tone === "ok"
        ? "text-term-green border-term-green/40 bg-term-green-soft"
        : tone === "warn"
          ? "text-amber-400 border-amber-500/40 bg-amber-500/10"
          : "text-red-400 border-red-500/40 bg-red-500/10";
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-md border text-[12px] font-semibold tabular-nums",
        cls,
      )}
    >
      <ShieldCheck className="size-3.5" />
      score · {score}
    </div>
  );
}
