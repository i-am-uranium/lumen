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

// Severity tones map to semantic tokens where one fits exactly (critical →
// danger, medium → warning, low → info). "high" sits between danger and
// warning and we don't carry an orange semantic token — use Tailwind orange
// with a dark: pair so it reads on both themes. "info" is the muted
// neutral chip and uses our text/border tokens.
const SEV_COLOR: Record<Severity, { bg: string; border: string; text: string; fill: string }> = {
  critical: {
    bg: "bg-danger-soft",
    border: "border-danger/40",
    text: "text-danger",
    fill: "bg-danger",
  },
  high: {
    bg: "bg-orange-500/15",
    border: "border-orange-600 dark:border-orange-500/40",
    text: "text-orange-700 dark:text-orange-400",
    fill: "bg-orange-600 dark:bg-orange-500",
  },
  medium: {
    bg: "bg-warning-soft",
    border: "border-warning/40",
    text: "text-warning",
    fill: "bg-warning",
  },
  low: {
    bg: "bg-info-soft",
    border: "border-info/40",
    text: "text-info",
    fill: "bg-info",
  },
  info: {
    bg: "bg-elevated",
    border: "border-border-default",
    text: "text-text-secondary",
    fill: "bg-border-strong",
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
      <div className="sticky top-0 z-10 bg-app/95 backdrop-blur border-b border-border-subtle">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <h1 className="mds-heading text-[20px] text-text-primary flex items-center gap-2">
              <ShieldAlert className="size-5" /> devsec
            </h1>
            <p className="text-[12px] text-text-secondary">
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
        <div className="grid grid-cols-5 border-t border-border-subtle">
          {SEVERITIES.map((s) => {
            const count = data?.counts_by_severity?.[s] ?? 0;
            const on = active.has(s);
            return (
              <button
                key={s}
                onClick={() => toggleSev(s)}
                className={cn(
                  "flex items-center gap-3 px-6 py-3 border-r border-border-subtle last:border-r-0 text-left transition-colors",
                  on ? SEV_COLOR[s].bg : "hover:bg-elevated",
                )}
              >
                <span className={cn("shrink-0", SEV_COLOR[s].text)}>{sevIcon(s)}</span>
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-text-muted">{s}</span>
                  <span
                    className={cn(
                      "text-[16px] font-semibold tabular-nums",
                      on ? SEV_COLOR[s].text : "text-text-primary",
                    )}
                  >
                    {count}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 px-6 py-3 border-t border-border-subtle">
          <div className="flex items-center gap-2 h-8 px-2 rounded-control bg-app border border-border-subtle flex-1 max-w-md">
            <Search className="size-3.5 text-text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by rule, resource, or namespace..."
              className="flex-1 bg-transparent outline-none text-[12px] text-text-primary placeholder:text-text-muted"
            />
          </div>
          <span className="text-[11px] text-text-muted">
            {filtered.length} of {findings.length} shown
          </span>
        </div>
      </div>

      <div className="p-6 space-y-3">
        {error ? (
          <div className="rounded-panel border border-danger/30 bg-[var(--status-error-soft)] p-4 text-[13px] text-danger">
            {(error as Error).message}
          </div>
        ) : isLoading ? (
          <div className="text-[13px] text-text-secondary flex items-center gap-2">
            <RefreshCw className="size-4 animate-spin" />
            scanning cluster...
          </div>
        ) : grouped.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <ShieldCheck className="size-10 text-success mb-3" />
            <p className="text-[14px] text-text-primary">no findings for the active filters.</p>
            <p className="text-[12px] text-text-secondary mt-1">
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
                  "rounded-panel border",
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
                      <span className="text-[11px] text-text-muted font-mono">{ruleId}</span>
                      <span className="text-[11px] text-text-muted">·</span>
                      <span className="text-[11px] text-text-muted">{group[0].category}</span>
                    </div>
                    <div className="mt-1 text-[13px] text-text-primary">
                      {group[0].title.replace(/ '.*'/, "")}
                    </div>
                    <div className="mt-0.5 text-[12px] text-text-secondary">
                      {group.length} affected resource{group.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  {expanded ? (
                    <ChevronDown className="size-4 text-text-muted mt-1" />
                  ) : (
                    <ChevronRight className="size-4 text-text-muted mt-1" />
                  )}
                </button>
                {expanded && (
                  <div className="px-4 pb-4">
                    <div className="mb-3 p-3 rounded bg-shell border border-border-subtle text-[12px] text-text-secondary">
                      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">
                        remediation
                      </div>
                      {group[0].remediation}
                    </div>
                    <div className="space-y-1.5">
                      {group.map((f, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-3 p-2 rounded border border-border-subtle bg-shell/60 text-[12px]"
                        >
                          <span className="text-text-muted font-mono w-[86px] shrink-0 uppercase text-[10px]">
                            {f.resource_kind}
                          </span>
                          <span className="text-text-primary shrink-0">{f.resource_name}</span>
                          {f.namespace && (
                            <span className="text-text-muted">· ns/{f.namespace}</span>
                          )}
                          <span className="flex-1 text-text-secondary truncate" title={f.detail}>
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
      ? "text-success border-success/40 bg-success/10"
      : tone === "ok"
        ? "text-accent-primary border-accent-primary/40 bg-accent-primary/10"
        : tone === "warn"
          ? "text-warning border-warning/40 bg-warning-soft"
          : "text-danger border-danger/40 bg-danger-soft";
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-control border text-[12px] font-semibold tabular-nums",
        cls,
      )}
    >
      <ShieldCheck className="size-3.5" />
      score · {score}
    </div>
  );
}
