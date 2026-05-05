import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { k8s, type VulnReport } from "@/lib/k8s";
import { cn } from "@/lib/utils";

/**
 * Image vulnerability scan section (D11).
 *
 * Lazy-loaded from {@link ResourceDetailDrawer}'s PropertiesTab so the
 * scan result rendering, severity pills, and trivy detection live in
 * their own chunk. Pods that never get scanned never pull this code.
 *
 * Wraps a copy of the drawer's tiny <Section> styling instead of
 * importing it — keeps this chunk free of a dependency on the parent
 * file (which would defeat the split via Vite's import-graph chunking).
 */
export function VulnScanSection({
  containers,
}: {
  containers: { name: string; image: string }[];
}) {
  const trivyAvailable = useQuery({
    queryKey: ["trivy", "available"],
    queryFn: () => k8s.detectTrivy(),
    staleTime: 60_000,
  });
  const [scans, setScans] = useState<
    Record<
      string,
      { loading: boolean; report?: VulnReport; error?: string }
    >
  >({});

  async function runScan(image: string) {
    setScans((prev) => ({ ...prev, [image]: { loading: true } }));
    try {
      const report = await k8s.scanImage(image);
      setScans((prev) => ({ ...prev, [image]: { loading: false, report } }));
    } catch (e) {
      setScans((prev) => ({
        ...prev,
        [image]: { loading: false, error: (e as Error).message ?? String(e) },
      }));
    }
  }

  if (trivyAvailable.isLoading) return null;
  return (
    <DrawerSection title="vulnerability scan">
      {!trivyAvailable.data ? (
        <div className="text-[11px] text-text-muted">
          trivy not detected on PATH — install via{" "}
          <code className="font-mono text-text-secondary">
            brew install trivy
          </code>{" "}
          /{" "}
          <code className="font-mono text-text-secondary">
            apt install trivy
          </code>{" "}
          /{" "}
          <code className="font-mono text-text-secondary">
            scoop install trivy
          </code>{" "}
          to enable image scanning.
        </div>
      ) : (
        <div className="space-y-2">
          {containers.map((c) => {
            const state = scans[c.image];
            return (
              <div
                key={c.name}
                className="rounded border border-border-subtle bg-elevated p-2"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-text-primary truncate flex-1">
                    {c.image}
                  </span>
                  <button
                    type="button"
                    onClick={() => runScan(c.image)}
                    disabled={state?.loading}
                    className="rounded border border-border-default bg-surface px-1.5 py-0.5 text-[10px] hover:bg-hover disabled:opacity-50"
                  >
                    {state?.loading
                      ? "scanning…"
                      : state?.report
                        ? "rescan"
                        : "scan"}
                  </button>
                </div>
                {state?.error && (
                  <div className="mt-1 text-[11px] text-danger">
                    {state.error}
                  </div>
                )}
                {state?.report && <VulnReportInline report={state.report} />}
              </div>
            );
          })}
        </div>
      )}
    </DrawerSection>
  );
}

function DrawerSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">
          {title}
        </span>
        <span className="flex-1 border-t border-dashed border-border-subtle" />
      </div>
      {children}
    </section>
  );
}

function VulnReportInline({ report }: { report: VulnReport }) {
  if (!report.scanner_available) {
    return (
      <div className="mt-1 text-[11px] text-text-muted">
        {report.note ?? "no result"}
      </div>
    );
  }
  const c = report.counts;
  const total = c.critical + c.high + c.medium + c.low + c.unknown;
  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono">
        <SevPill label="C" count={c.critical} tone="critical" />
        <SevPill label="H" count={c.high} tone="high" />
        <SevPill label="M" count={c.medium} tone="medium" />
        <SevPill label="L" count={c.low} tone="low" />
        <span className="text-text-muted">· {total} findings</span>
      </div>
      {total > 0 && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto pr-1">
          {report.findings.slice(0, 25).map((f) => (
            <li
              key={`${f.id}-${f.package}`}
              className="flex items-baseline gap-2 text-[11px]"
            >
              <SevDot severity={f.severity} />
              <span className="font-mono text-text-primary">{f.id}</span>
              <span className="font-mono text-text-muted truncate">
                {f.package}@{f.installed_version}
              </span>
              {f.fixed_version && (
                <span className="font-mono text-success">
                  → {f.fixed_version}
                </span>
              )}
            </li>
          ))}
          {report.findings.length > 25 && (
            <li className="text-[10px] text-text-muted pl-3">
              + {report.findings.length - 25} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function SevPill({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "critical" | "high" | "medium" | "low";
}) {
  const cls =
    count === 0
      ? "border-border-subtle bg-transparent text-text-muted"
      : tone === "critical"
        ? "border-danger/40 bg-danger-soft text-danger"
        : tone === "high"
          ? "border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-400"
          : tone === "medium"
            ? "border-warning/40 bg-warning-soft text-warning"
            : "border-info/40 bg-info-soft text-info";
  return (
    <span
      className={cn(
        "inline-flex h-4 items-center gap-1 rounded border px-1 font-mono uppercase",
        cls,
      )}
    >
      {label} {count}
    </span>
  );
}

function SevDot({ severity }: { severity: string }) {
  const tone =
    severity === "CRITICAL"
      ? "bg-danger"
      : severity === "HIGH"
        ? "bg-orange-600 dark:bg-orange-500"
        : severity === "MEDIUM"
          ? "bg-warning"
          : "bg-info";
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", tone)}
      title={severity}
      aria-label={severity}
    />
  );
}
