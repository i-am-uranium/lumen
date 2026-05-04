import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LogLine } from "@/state/logs";

// Strip ANSI color sequences; we render color ourselves.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Well-known field names that could carry the message / level / timestamp
// across common structured loggers (pino, winston, zap, slog, bunyan, klog).
const MSG_KEYS = ["msg", "message", "log", "event"];
const LEVEL_KEYS = ["level", "lvl", "severity"];
const TIME_KEYS = ["ts", "time", "timestamp", "@timestamp", "eventTime"];

const LEVEL_TONE: Record<string, string> = {
  trace: "text-slate-400 bg-slate-500/10 border-slate-500/30",
  debug: "text-slate-300 bg-slate-500/10 border-slate-500/30",
  info: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30",
  notice: "text-sky-300 bg-sky-500/10 border-sky-500/30",
  warn: "text-amber-300 bg-amber-500/10 border-amber-500/30",
  warning: "text-amber-300 bg-amber-500/10 border-amber-500/30",
  error: "text-red-300 bg-red-500/10 border-red-500/30",
  err: "text-red-300 bg-red-500/10 border-red-500/30",
  fatal: "text-red-200 bg-red-600/20 border-red-500/40",
  crit: "text-red-200 bg-red-600/20 border-red-500/40",
  panic: "text-red-200 bg-red-600/20 border-red-500/40",
};

type Parsed = {
  ts: string | null;
  level: string | null;
  message: string;
  extras: Record<string, unknown> | null;
  raw: string;
};

function pluck(obj: Record<string, unknown>, keys: string[]): { value: string | null; key: string | null } {
  for (const k of keys) {
    if (k in obj) {
      const v = obj[k];
      if (typeof v === "string" || typeof v === "number") {
        return { value: String(v), key: k };
      }
      if (typeof v === "object" && v !== null) {
        return { value: JSON.stringify(v), key: k };
      }
    }
  }
  return { value: null, key: null };
}

function normalizeLevel(raw: string | null): string | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isNaN(n)) {
    // pino numeric levels: 10=trace 20=debug 30=info 40=warn 50=error 60=fatal
    if (n >= 60) return "fatal";
    if (n >= 50) return "error";
    if (n >= 40) return "warn";
    if (n >= 30) return "info";
    if (n >= 20) return "debug";
    return "trace";
  }
  return raw.toLowerCase();
}

function parseLine(raw: string): Parsed {
  const stripped = raw.replace(ANSI_RE, "");
  const trimmed = stripped.trimStart();

  // JSON log path.
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const { value: message, key: msgKey } = pluck(obj, MSG_KEYS);
      const { value: levelRaw, key: lvlKey } = pluck(obj, LEVEL_KEYS);
      const { value: tsRaw, key: tsKey } = pluck(obj, TIME_KEYS);
      const extras: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === msgKey || k === lvlKey || k === tsKey) continue;
        extras[k] = v;
      }
      return {
        ts: tsRaw ? formatTs(tsRaw) : null,
        level: normalizeLevel(levelRaw),
        message: message ?? trimmed,
        extras: Object.keys(extras).length ? extras : null,
        raw,
      };
    } catch {
      // fall through
    }
  }

  // Plain text with leading RFC3339 / klog-style / bracketed-level prefixes.
  let ts: string | null = null;
  let level: string | null = null;
  let msg = stripped;

  const isoRe = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+\-]\d{2}:?\d{2})?)\s+/;
  const isoMatch = stripped.match(isoRe);
  if (isoMatch) {
    ts = formatTs(isoMatch[1]);
    msg = stripped.slice(isoMatch[0].length);
  }

  const brLvl = msg.match(/^\[(trace|debug|info|notice|warn|warning|error|err|fatal|crit|panic)\]\s*/i);
  if (brLvl) {
    level = brLvl[1].toLowerCase();
    msg = msg.slice(brLvl[0].length);
  } else {
    const kvLvl = msg.match(/\blevel=(\w+)/i);
    if (kvLvl) level = kvLvl[1].toLowerCase();
  }

  return { ts, level, message: msg, extras: null, raw };
}

function formatTs(raw: string): string {
  // Try Date parse; if numeric, assume epoch ms or s.
  const n = Number(raw);
  if (!Number.isNaN(n)) {
    const d = new Date(n > 1e12 ? n : n * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(11, 23);
  }
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(11, 23);
  return raw.slice(0, 23);
}

function Highlighted({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lc = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lc.indexOf(ql, i);
    if (idx === -1) {
      out.push(text.slice(i));
      break;
    }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark
        key={idx}
        className="bg-accent-primary-soft text-text-primary rounded-sm px-0.5"
      >
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return <>{out}</>;
}

export function LogLineRow({
  line,
  color,
  highlight,
}: {
  line: LogLine;
  color: string;
  highlight?: string;
}) {
  const [open, setOpen] = useState(false);
  const parsed = useMemo(() => parseLine(line.text), [line.text]);
  const hasExtras = parsed.extras !== null;
  const levelKey = parsed.level ?? "";
  const levelTone = LEVEL_TONE[levelKey] ?? "";

  return (
    <div
      className={cn(
        "group border-b border-border-subtle/40 px-3 py-1 text-[12px] leading-[18px]",
        "font-mono [font-feature-settings:'liga'_0,'calt'_0] [font-variant-ligatures:none]",
        hasExtras && "cursor-pointer hover:bg-hover",
      )}
      onClick={() => hasExtras && setOpen((o) => !o)}
    >
      <div className="flex items-start gap-2">
        {hasExtras ? (
          <span className="shrink-0 text-text-muted mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </span>
        ) : (
          <span className="shrink-0 w-3" />
        )}

        {parsed.ts && (
          <span className="shrink-0 w-[84px] text-text-muted tabular-nums truncate">
            {parsed.ts}
          </span>
        )}

        {parsed.level && (
          <span
            className={cn(
              "shrink-0 inline-flex items-center justify-center px-1.5 h-[16px] rounded border text-[10px] uppercase font-semibold tracking-wide leading-none",
              levelTone || "text-text-secondary bg-elevated border-border-default",
            )}
          >
            {parsed.level}
          </span>
        )}

        <span
          className={cn("shrink-0 w-[180px] truncate", color)}
          title={`${line.pod}/${line.container}`}
        >
          {line.pod}
        </span>

        <span className="flex-1 min-w-0 whitespace-pre-wrap break-words text-text-primary">
          <Highlighted text={parsed.message} q={highlight ?? ""} />
        </span>
      </div>

      {open && parsed.extras && (
        <div
          className="mt-1.5 ml-[calc(12px+8px+84px+8px)] rounded-control border border-border-default bg-shell/70 p-2 text-[11px]"
          onClick={(e) => e.stopPropagation()}
        >
          <table className="w-full">
            <tbody>
              {Object.entries(parsed.extras).map(([k, v]) => (
                <tr key={k} className="align-top">
                  <td className="pr-3 py-0.5 text-text-muted w-[140px] font-semibold tabular-nums">
                    {k}
                  </td>
                  <td className="py-0.5 text-text-primary break-all whitespace-pre-wrap">
                    {typeof v === "object"
                      ? JSON.stringify(v, null, 2)
                      : String(v)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
