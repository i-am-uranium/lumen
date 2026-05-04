import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowRight, Copy, Square, X } from "lucide-react";
import { toast } from "sonner";
import { k8s, type ForwardSession } from "@/lib/k8s";
import { cn } from "@/lib/utils";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/**
 * Header chip that shows active port-forward count and opens a manager
 * popover on click. Polls every 2s so byte counters feel live.
 */
export function PortForwardsChip() {
  const [open, setOpen] = useState(false);
  const { data = [] } = useQuery({
    queryKey: ["k8s", "forwards"],
    queryFn: k8s.listPortForwards,
    refetchInterval: 2_000,
  });
  if (!data.length && !open) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 px-2 h-7 rounded-md border text-[11px] transition-colors",
          data.length > 0
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            : "border-term-border-soft text-term-muted hover:text-term-fg",
        )}
      >
        <Activity className="size-3" />
        {data.length > 0 ? `${data.length} forward${data.length === 1 ? "" : "s"}` : "forwards"}
      </button>
      {open && (
        <ForwardsPanel sessions={data} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function ForwardsPanel({
  sessions,
  onClose,
}: {
  sessions: ForwardSession[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const stop = async (id: string) => {
    try {
      await k8s.stopPortForward(id);
      qc.invalidateQueries({ queryKey: ["k8s", "forwards"] });
      toast.success("forward stopped");
    } catch (e) {
      toast.error(`stop failed: ${(e as Error).message ?? e}`);
    }
  };
  const copy = async (s: ForwardSession) => {
    await navigator.clipboard.writeText(`http://127.0.0.1:${s.local_port}`);
    toast.success(`localhost:${s.local_port} copied`);
  };
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 top-9 z-50 w-[420px] rounded-lg border border-term-border bg-term-panel shadow-2xl">
        <div className="flex items-center justify-between px-3 h-10 border-b border-term-border-soft">
          <span className="text-[12px] font-semibold text-term-fg">active port-forwards</span>
          <button onClick={onClose} className="text-term-subtle hover:text-term-fg">
            <X className="size-4" />
          </button>
        </div>
        {sessions.length === 0 ? (
          <div className="p-4 text-[12px] text-term-muted text-center">
            no active forwards. Start one from the CloudMap inspector.
          </div>
        ) : (
          <ul className="divide-y divide-term-border-soft max-h-[360px] overflow-y-auto">
            {sessions.map((s) => (
              <li key={s.id} className="p-3 text-[12px]">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-term-subtle">
                    {s.target_kind}
                  </span>
                  <span className="text-term-fg font-mono truncate" title={s.target_name}>
                    {s.target_name}
                  </span>
                  <span className="ml-auto text-[10px] text-term-subtle tabular-nums">
                    ↑{formatBytes(s.bytes_out)} · ↓{formatBytes(s.bytes_in)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-term-muted font-mono">
                  <span className="text-term-green">127.0.0.1:{s.local_port}</span>
                  <ArrowRight className="size-3 text-term-subtle" />
                  <span className="truncate">
                    {s.pod_name !== s.target_name && (
                      <span className="text-term-subtle">{s.pod_name} · </span>
                    )}
                    :{s.remote_port}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-term-subtle">
                  <span>ns: {s.namespace}</span>
                  <span>· ctx: {s.context}</span>
                  <span>· {s.connections} connection{s.connections === 1 ? "" : "s"}</span>
                </div>
                {s.last_error && (
                  <div className="mt-1 text-[11px] text-term-red truncate" title={s.last_error}>
                    ! {s.last_error}
                  </div>
                )}
                <div className="mt-2 flex gap-1.5">
                  <button
                    onClick={() => copy(s)}
                    className="term-btn !min-h-[26px] !py-1 !px-2 !text-[11px]"
                  >
                    <Copy className="size-3" /> copy URL
                  </button>
                  <button
                    onClick={() => stop(s.id)}
                    className="term-btn !min-h-[26px] !py-1 !px-2 !text-[11px] !text-term-red !border-term-red/40"
                  >
                    <Square className="size-3" /> stop
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
