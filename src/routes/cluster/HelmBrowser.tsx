import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  CircleDot,
  Clock,
  ExternalLink,
  History,
  Lock,
  Package,
  Plus,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import {
  k8s,
  type HelmReleaseDetail,
  type HelmReleaseSummary,
} from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { HelmActionDialog } from "@/components/HelmActionDialog";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { useUiSettings } from "@/state/uiSettings";

type HelmAction =
  | { kind: "rollback"; release: string; namespace: string; revision: number; wait: boolean }
  | { kind: "uninstall"; release: string; namespace: string; keepHistory: boolean };

type Tab = "values" | "chart_values" | "manifest" | "notes" | "history";

function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase();
  const tone =
    s === "deployed"
      ? "text-success bg-success-soft border-success/40"
      : s === "failed"
        ? "text-danger bg-danger-soft border-danger/40"
        : s.includes("pending") || s === "uninstalling"
          ? "text-warning bg-warning-soft border-warning/40"
          : s === "superseded"
            ? "text-text-secondary bg-elevated border-border-default"
            : "text-term-subtle bg-term-panel-2 border-term-border-soft";
  const Icon =
    s === "deployed"
      ? CheckCircle2
      : s === "failed"
        ? CircleAlert
        : s === "superseded"
          ? CircleDashed
          : CircleDot;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border font-semibold uppercase tracking-wide",
        tone,
      )}
    >
      <Icon className="size-2.5" />
      {status}
    </span>
  );
}

function formatTs(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

export function HelmBrowser() {
  const { ctx = "" } = useParams();
  const navigate = useNavigate();
  const context = decodeURIComponent(ctx);
  const readOnly = useUiSettings((s) => s.readOnly);
  const releases = useQuery({
    queryKey: ["k8s", "helm", context],
    queryFn: () => k8s.listHelmReleases(context || undefined),
    staleTime: 30_000,
  });

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<HelmReleaseSummary | null>(null);

  const goInstall = () => {
    if (readOnly) return;
    navigate(`/cluster/${encodeURIComponent(context)}/helm/install`);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = releases.data ?? [];
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.namespace.toLowerCase().includes(q) ||
        r.chart_name.toLowerCase().includes(q),
    );
  }, [releases.data, query]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[360px] border-r border-term-border-soft bg-term-panel flex flex-col min-h-0">
        <div className="flex items-center justify-between px-4 h-12 border-b border-term-border-soft shrink-0">
          <h2 className="mds-heading text-[14px] text-term-fg flex items-center gap-2">
            <Package className="size-4" /> helm
            <span className="text-[11px] text-term-subtle font-normal">
              {releases.data?.length ?? 0}
            </span>
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={goInstall}
              disabled={readOnly}
              title={
                readOnly
                  ? "install disabled — read-only mode is on"
                  : "install a chart"
              }
              className="term-btn !min-h-[26px] !py-1 !px-2 !text-[11px] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {readOnly ? <Lock className="size-3" /> : <Plus className="size-3" />}
              install
            </button>
            <button
              onClick={() => releases.refetch()}
              disabled={releases.isFetching}
              className="text-term-muted hover:text-term-fg p-1"
              title="refresh"
            >
              <RefreshCw
                className={cn("size-3.5", releases.isFetching && "animate-spin")}
              />
            </button>
          </div>
        </div>
        <div className="p-2 border-b border-term-border-soft">
          <div className="flex items-center gap-2 h-8 px-2 rounded-md bg-term-bg border border-term-border-soft">
            <Search className="size-3.5 text-term-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter releases..."
              className="flex-1 bg-transparent outline-none text-[12px] text-term-fg placeholder:text-term-subtle"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {releases.error ? (
            <div className="p-3 text-[12px] text-term-red">
              {(releases.error as Error).message}
            </div>
          ) : releases.isLoading ? (
            <div className="p-3 text-[12px] text-term-muted">looking for Helm v3 releases…</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-[12px] text-term-muted">
              {query
                ? "no releases match."
                : "no Helm v3 releases in this cluster."}
            </div>
          ) : (
            filtered.map((r) => {
              const active =
                selected?.name === r.name && selected?.namespace === r.namespace;
              return (
                <button
                  key={`${r.namespace}/${r.name}`}
                  onClick={() => setSelected(r)}
                  className={cn(
                    "w-full text-left px-3 py-2 border-b border-term-border-soft/60 hover:bg-term-panel-2 transition-colors",
                    active && "bg-term-green-soft",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "text-[13px] font-semibold truncate",
                        active ? "text-term-green" : "text-term-fg",
                      )}
                    >
                      {r.name}
                    </span>
                    <span className="ml-auto text-[11px] font-mono text-term-subtle tabular-nums">
                      v{r.revision}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-term-muted font-mono">
                    <span className="truncate">{r.chart_name}</span>
                    <span className="text-term-subtle">{r.chart_version}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px]">
                    <StatusPill status={r.status} />
                    <span className="text-term-subtle">
                      ns/{r.namespace}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-hidden">
        {!selected ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-term-muted gap-2">
            <Package className="size-6" />
            <p className="text-[13px]">select a release to inspect values, chart, and manifest</p>
          </div>
        ) : (
          <ReleaseDetail
            context={context}
            key={`${selected.namespace}/${selected.name}`}
            summary={selected}
            readOnly={readOnly}
          />
        )}
      </main>
    </div>
  );
}

function ReleaseDetail({
  context,
  summary,
  readOnly,
}: {
  context: string;
  summary: HelmReleaseSummary;
  readOnly: boolean;
}) {
  const navigate = useNavigate();
  const [revision, setRevision] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("values");
  const [action, setAction] = useState<HelmAction | null>(null);
  const [confirmAction, setConfirmAction] = useState<HelmAction | null>(null);
  const detail = useQuery({
    queryKey: [
      "k8s",
      "helm-detail",
      context,
      summary.namespace,
      summary.name,
      revision,
    ],
    queryFn: () =>
      k8s.getHelmRelease(
        summary.namespace,
        summary.name,
        revision ?? undefined,
        context || undefined,
      ),
    staleTime: 30_000,
  });

  const d: HelmReleaseDetail | undefined = detail.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="px-5 py-3 border-b border-term-border-soft bg-term-panel shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="mds-heading text-[16px] text-term-fg flex items-center gap-2">
            {summary.name}
          </h2>
          <span className="text-[11px] text-term-subtle font-mono">
            ns/{summary.namespace}
          </span>
          <StatusPill status={d?.summary.status ?? summary.status} />
          <span className="ml-auto text-[11px] text-term-muted tabular-nums flex items-center gap-1">
            <Clock className="size-3" />
            last deployed {formatTs(d?.summary.last_deployed ?? summary.last_deployed)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-[12px] text-term-muted">
          <span className="font-mono">
            {d?.summary.chart_name ?? summary.chart_name}
          </span>
          <span className="inline-flex items-center gap-1">
            <Tag className="size-3" /> chart {d?.summary.chart_version ?? summary.chart_version}
          </span>
          <span>· app {d?.summary.app_version ?? summary.app_version}</span>
          <span className="text-term-subtle">
            · revision <span className="font-mono">v{d?.summary.revision ?? summary.revision}</span>
          </span>
          {d?.chart_home && (
            <a
              href={d.chart_home}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-term-green hover:underline ml-auto"
            >
              chart home <ExternalLink className="size-3" />
            </a>
          )}
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <button
            onClick={() => {
              if (readOnly) return;
              navigate(
                `/cluster/${encodeURIComponent(context)}/helm/upgrade/${encodeURIComponent(summary.name)}?ns=${encodeURIComponent(summary.namespace)}`,
              );
            }}
            disabled={readOnly}
            className="term-btn !min-h-[26px] !py-1 !px-2 !text-[11px] disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              readOnly
                ? "upgrade disabled — read-only mode is on"
                : "helm upgrade this release"
            }
          >
            {readOnly ? <Lock className="size-3" /> : <Upload className="size-3" />}
            upgrade
          </button>
          <button
            onClick={() =>
              !readOnly &&
              setConfirmAction({
                kind: "uninstall",
                release: summary.name,
                namespace: summary.namespace,
                keepHistory: false,
              })
            }
            disabled={readOnly}
            className="term-btn !min-h-[26px] !py-1 !px-2 !text-[11px] !text-term-red !border-term-red/40 disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              readOnly
                ? "uninstall disabled — read-only mode is on"
                : "helm uninstall this release"
            }
          >
            {readOnly ? <Lock className="size-3" /> : <Trash2 className="size-3" />}
            uninstall
          </button>
        </div>
        {d?.chart_description && (
          <p className="mt-1.5 text-[12px] text-term-muted max-w-3xl">
            {d.chart_description}
          </p>
        )}
      </header>

      <nav className="px-4 py-2 border-b border-term-border-soft flex items-center gap-1 shrink-0">
        {(
          [
            ["values", "user values"],
            ["chart_values", "chart values"],
            ["manifest", "manifest"],
            ["notes", "NOTES"],
            ["history", "history"],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn(
              "px-3 h-7 rounded-md text-[12px] border transition-colors",
              tab === k
                ? "border-term-green/60 bg-term-green-soft text-term-green"
                : "border-transparent text-term-muted hover:text-term-fg hover:bg-term-panel-2",
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="flex-1 min-h-0 overflow-auto">
        {detail.error ? (
          <div className="p-4 text-[12px] text-term-red">
            {(detail.error as Error).message}
          </div>
        ) : detail.isLoading || !d ? (
          <div className="p-4 text-[12px] text-term-muted">loading release…</div>
        ) : tab === "values" ? (
          <YamlPane
            empty="chart installed with default values only."
            body={d.user_values_yaml.trim() === "{}" ? "" : d.user_values_yaml}
          />
        ) : tab === "chart_values" ? (
          <YamlPane body={d.chart_values_yaml} empty="chart has no default values." />
        ) : tab === "manifest" ? (
          <YamlPane body={d.manifest} empty="no rendered manifest." />
        ) : tab === "notes" ? (
          <YamlPane body={d.notes ?? ""} empty="chart has no NOTES.txt." />
        ) : (
          <HistoryPane
            context={context}
            namespace={summary.namespace}
            name={summary.name}
            current={d.summary.revision}
            readOnly={readOnly}
            onPick={(r) => setRevision(r)}
            onRollback={(r) =>
              setConfirmAction({
                kind: "rollback",
                release: summary.name,
                namespace: summary.namespace,
                revision: r,
                wait: true,
              })
            }
          />
        )}
      </div>
      {action && (
        <HelmActionDialog
          action={action}
          context={context}
          onClose={() => setAction(null)}
        />
      )}
      {confirmAction && (
        <ConfirmActionDialog
          open
          title={
            confirmAction.kind === "uninstall"
              ? `uninstall ${confirmAction.release}`
              : `rollback ${confirmAction.release}`
          }
          description={
            confirmAction.kind === "uninstall"
              ? `Uninstall release ${confirmAction.release} from namespace ${confirmAction.namespace}. Resources managed by this release will be deleted.`
              : `Rollback ${confirmAction.release} to revision ${confirmAction.revision}. Helm will create a new revision from that manifest.`
          }
          target={`${confirmAction.namespace}/${confirmAction.release}`}
          confirmLabel={confirmAction.kind === "uninstall" ? "uninstall" : "rollback"}
          intent={confirmAction.kind === "uninstall" ? "danger" : "warning"}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => {
            setAction(confirmAction);
            setConfirmAction(null);
          }}
        />
      )}
    </div>
  );
}

function YamlPane({ body, empty }: { body: string; empty: string }) {
  if (!body || body.trim() === "") {
    return <div className="p-4 text-[12px] text-term-muted">{empty}</div>;
  }
  return (
    <pre className="p-4 text-[12px] text-term-fg font-mono leading-relaxed whitespace-pre">
      {body}
    </pre>
  );
}

function HistoryPane({
  context,
  namespace,
  name,
  current,
  readOnly,
  onPick,
  onRollback,
}: {
  context: string;
  namespace: string;
  name: string;
  current: number;
  readOnly: boolean;
  onPick: (r: number) => void;
  onRollback: (r: number) => void;
}) {
  const q = useQuery({
    queryKey: ["k8s", "helm-history", context, namespace, name],
    queryFn: () => k8s.listHelmHistory(namespace, name, context || undefined),
    staleTime: 30_000,
  });
  if (q.error) {
    return <div className="p-4 text-[12px] text-term-red">{(q.error as Error).message}</div>;
  }
  if (q.isLoading || !q.data) {
    return <div className="p-4 text-[12px] text-term-muted">loading history…</div>;
  }
  return (
    <div className="p-4">
      <h3 className="text-[11px] uppercase tracking-wider text-term-subtle mb-2 flex items-center gap-1">
        <History className="size-3" /> revisions ({q.data.length})
      </h3>
      <ul className="divide-y divide-term-border-soft border border-term-border-soft rounded-md overflow-hidden">
        {q.data
          .slice()
          .reverse()
          .map((r) => (
            <li
              key={r.revision}
              className="p-3 flex items-center gap-3 text-[12px] hover:bg-term-panel-2"
            >
              <span className="font-mono text-term-fg tabular-nums w-10">
                v{r.revision}
              </span>
              <StatusPill status={r.status} />
              <span className="text-term-muted font-mono">{r.chart_version}</span>
              <span className="text-term-subtle truncate flex-1" title={r.description ?? ""}>
                {r.description ?? "—"}
              </span>
              <span className="text-term-subtle tabular-nums">
                {formatTs(r.last_deployed)}
              </span>
              <button
                onClick={() => onPick(r.revision)}
                disabled={r.revision === current}
                className="term-btn !min-h-[26px] !py-1 !px-2 !text-[11px] disabled:opacity-50"
              >
                {r.revision === current ? "current" : "view"}
              </button>
              {r.revision !== current && (
                <button
                  onClick={() => !readOnly && onRollback(r.revision)}
                  disabled={readOnly}
                  className="term-btn !min-h-[26px] !py-1 !px-2 !text-[11px] !text-term-amber !border-term-amber/40 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={
                    readOnly
                      ? "rollback disabled — read-only mode is on"
                      : `helm rollback ${name} ${r.revision}`
                  }
                >
                  {readOnly ? <Lock className="size-3" /> : <Undo2 className="size-3" />}
                  rollback
                </button>
              )}
            </li>
          ))}
      </ul>
    </div>
  );
}
