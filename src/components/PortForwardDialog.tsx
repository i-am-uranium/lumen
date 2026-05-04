import { useState } from "react";
import { ArrowRight, X } from "lucide-react";
import { toast } from "sonner";
import { k8s, type ForwardTargetKind } from "@/lib/k8s";

type Props = {
  context: string;
  namespace: string;
  targetKind: ForwardTargetKind;
  targetName: string;
  /** Suggested remote ports. Users can override. */
  suggestedPorts?: number[];
  onClose: () => void;
  onStarted?: () => void;
};

/** Small modal to collect local/remote ports and kick off a port-forward.
 * The actual tunnel runs in the Rust backend; this UI only initiates it. */
export function PortForwardDialog({
  context,
  namespace,
  targetKind,
  targetName,
  suggestedPorts,
  onClose,
  onStarted,
}: Props) {
  const initialRemote = suggestedPorts?.[0] ?? 8080;
  const [remote, setRemote] = useState<number>(initialRemote);
  const [local, setLocal] = useState<number>(initialRemote);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    if (local < 1 || local > 65535 || remote < 1 || remote > 65535) {
      toast.error("ports must be 1-65535");
      return;
    }
    setBusy(true);
    try {
      await k8s.startPortForward({
        namespace,
        targetKind,
        targetName,
        localPort: local,
        remotePort: remote,
        context: context || undefined,
      });
      toast.success(`forwarding 127.0.0.1:${local} → ${targetName}:${remote}`);
      onStarted?.();
      onClose();
    } catch (e) {
      toast.error(`port-forward failed: ${(e as Error).message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-term-panel border border-term-border rounded-lg max-w-sm w-full shadow-2xl"
      >
        <div className="flex items-center justify-between px-4 h-11 border-b border-term-border-soft">
          <h3 className="text-[13px] font-semibold text-term-fg">
            port-forward · {targetKind}/{targetName}
          </h3>
          <button onClick={onClose} className="text-term-subtle hover:text-term-fg">
            <X className="size-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 text-[12px]">
          <p className="text-term-muted">
            Tunnels a local TCP listener on <span className="font-mono text-term-fg">127.0.0.1</span>
            {" "}to {targetKind === "service" ? "a pod backing the service" : "the pod"} through the
            apiserver. Nothing is exposed beyond this machine.
          </p>
          <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
            <div>
              <label className="mds-label text-term-subtle mb-1 block">local</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={local}
                onChange={(e) => setLocal(parseInt(e.target.value || "0", 10))}
                className="term-input w-full"
              />
            </div>
            <ArrowRight className="size-4 text-term-subtle mb-2.5" />
            <div>
              <label className="mds-label text-term-subtle mb-1 block">remote</label>
              <input
                type="number"
                min={1}
                max={65535}
                value={remote}
                onChange={(e) => setRemote(parseInt(e.target.value || "0", 10))}
                className="term-input w-full"
              />
            </div>
          </div>
          {suggestedPorts && suggestedPorts.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              <span className="text-term-subtle text-[11px] mr-1 self-center">
                suggested:
              </span>
              {suggestedPorts.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setRemote(p);
                    setLocal(p);
                  }}
                  className="px-1.5 py-0.5 rounded border border-term-border-soft text-[11px] font-mono text-term-muted hover:text-term-fg hover:bg-term-panel-2"
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t border-term-border-soft flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="term-btn !min-h-[30px] !text-[11px]"
          >
            cancel
          </button>
          <button
            onClick={go}
            disabled={busy}
            className="term-btn term-btn-primary !min-h-[30px] !text-[11px]"
          >
            {busy ? "starting..." : "start forward"}
          </button>
        </div>
      </div>
    </div>
  );
}
