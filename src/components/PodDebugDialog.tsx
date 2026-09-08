import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useMutationCapability } from "@/hooks/useMutationCapability";
import { useShellDock } from "@/hooks/useShellDock";
import { protectionErrorMessage } from "@/lib/contextProtection";
import { k8s } from "@/lib/k8s";
import type { DebugContainer, DebugProfile, DebugRequest, DebugTarget } from "@/lib/podDebug";

export type PodDebugSelection = { context: string; namespace: string; pod: string };
export function PodDebugDialog({ selection, onClose }: { selection: PodDebugSelection; onClose: () => void }) {
  // Capture selection once. Requests and terminals never follow later drawer changes.
  const [captured] = useState(() => ({ ...selection }));
  const [identity, setIdentity] = useState<DebugTarget | null>(null);
  const [target, setTarget] = useState("");
  const [image, setImage] = useState("busybox:1.37");
  const [command, setCommand] = useState('["sleep", "3600"]');
  const [shell, setShell] = useState("/bin/sh");
  const [profile, setProfile] = useState<DebugProfile>("restricted");
  const [request, setRequest] = useState<DebugRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DebugContainer | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const capability = useMutationCapability(captured.context);
  const { openSession } = useShellDock();
  const status = useQuery({ queryKey: ["pod-debug", captured.context, captured.namespace, captured.pod], queryFn: () => k8s.getDebugTarget(captured.context, captured.namespace, captured.pod), retry: false, staleTime: 0 });
  useEffect(() => {
    const data = status.data;
    if (data && !identity && data.context === captured.context && data.namespace === captured.namespace && data.pod === captured.pod) {
      setIdentity(data); setTarget(data.containers[0] ?? "");
    }
  }, [status.data, identity, captured]);
  const current = status.data;
  const matches = !!identity && !!current && current.context === captured.context && current.namespace === captured.namespace && current.pod === captured.pod && current.pod_uid === identity.pod_uid;
  const available = matches && !current!.deleting && !["Succeeded", "Failed"].includes(current!.phase) && !status.isError;
  const containers = current?.ephemeral_containers ?? [];
  const displayed = result && !containers.some((c) => c.name === result.name) ? [...containers, result] : containers;

  async function create() {
    if (!available || !capability.canMutate || busy || !identity) return;
    let pending = request;
    if (!pending) {
      try {
        const args: unknown = JSON.parse(command);
        if (!Array.isArray(args) || !args.length || args.some((value) => typeof value !== "string") || !args[0].trim()) throw new Error("Command must be a JSON array of arguments, for example [\"sleep\", \"3600\"].");
        if (!image.trim() || !target) throw new Error("Choose a target container and diagnostic image.");
        pending = { ...captured, pod_uid: identity.pod_uid, target_container: target, name: `lumen-debug-${crypto.randomUUID().slice(0, 12)}`, image: image.trim(), command: args as string[], profile };
      } catch (failure) { setError(protectionErrorMessage(failure)); return; }
      setRequest(pending);
    }
    setBusy(true); setError(null);
    try {
      const created = await k8s.createDebugContainer(pending);
      if (!mounted.current) return;
      setResult(created.container);
      void status.refetch();
    } catch (failure) { if (mounted.current) setError(protectionErrorMessage(failure)); }
    finally { if (mounted.current) setBusy(false); }
  }
  function open(container: DebugContainer) {
    if (!identity || !available || !capability.canMutate || container.state !== "running" || !shell.trim()) return;
    openSession({ context: captured.context, namespace: captured.namespace, pod: captured.pod, podUid: identity.pod_uid, container: container.name, command: [shell.trim()] });
    onClose();
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto border-border-default bg-elevated">
      <DialogHeader><DialogTitle>Debug container</DialogTitle><DialogDescription>Add a diagnostic container to this pod, then use the existing terminal.</DialogDescription></DialogHeader>
      <p className="text-xs font-mono break-all">{captured.context} / {captured.namespace} / {captured.pod}<br />Pod UID: {identity?.pod_uid ?? "loading"}</p>
      <p className="text-xs text-text-secondary">Creation changes the pod. Ephemeral containers stay in its specification until the pod is deleted and cannot restart or be removed individually. Closing a terminal does not remove the container or stop its main command. The default command exits after one hour.</p>
      <p className="text-xs text-text-secondary">Both profiles use UID 1000, drop all capabilities, disable privilege escalation and use RuntimeDefault seccomp. Target process visibility depends on runtime support and permissions. The target filesystem is not automatically mounted; networking is shared with the pod. Tools needing elevated privileges may fail.</p>
      {status.isPending && <p role="status">Reading pod identity and container status…</p>}
      {status.isError && <p role="alert">{protectionErrorMessage(status.error)}</p>}
      {identity && !matches && current && <p role="alert">The pod was replaced. Close this dialog and select it again.</p>}
      {current && (current.deleting || ["Succeeded", "Failed"].includes(current.phase)) && <p role="alert">This pod is deleting or completed; debugging is unavailable.</p>}
      {!capability.canMutate && <p role="status" className="text-xs text-warning">{capability.reason}</p>}
      <fieldset disabled={busy || !!request} className="grid gap-3">
        <label className="grid gap-1 text-xs">Target container<select aria-label="Target container" value={target} onChange={(e) => setTarget(e.target.value)} className="border border-border-default rounded-control bg-elevated px-2 py-1">{identity?.containers.map((name) => <option key={name}>{name}</option>)}</select></label>
        <label className="grid gap-1 text-xs">Diagnostic image<Input value={image} onChange={(e) => setImage(e.target.value)} /></label>
        <label className="grid gap-1 text-xs">Container command (JSON argument array)<Input value={command} onChange={(e) => setCommand(e.target.value)} /></label>
        <label className="grid gap-1 text-xs">Unprivileged profile<select aria-label="Unprivileged profile" value={profile} onChange={(e) => setProfile(e.target.value as DebugProfile)} className="border border-border-default rounded-control bg-elevated px-2 py-1"><option value="restricted">Restricted — read-only root filesystem</option><option value="baseline">Baseline — writable diagnostic root filesystem</option></select></label>
      </fieldset>
      {request && <p className="text-xs font-mono break-all">Request: {request.name}. Retry keeps this exact name and configuration.</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2 flex-wrap">
        <Button disabled={!available || !capability.canMutate || busy} onClick={() => void create()}>{busy ? "Waiting for container…" : request ? "Retry same container" : "Create debug container"}</Button>
        <Button variant="outline" disabled={busy || status.isFetching} onClick={() => void status.refetch()}>Refresh status</Button>
        {request && <Button variant="outline" disabled={busy} onClick={() => { setRequest(null); setResult(null); setError(null); }}>Configure another container</Button>}
      </div>
      {request && <p className="text-xs text-text-secondary">Configuring another container leaves this one unchanged, including after a timeout. Closing this dialog does not cancel a submitted request.</p>}
      <label className="grid gap-1 text-xs">Terminal executable<Input value={shell} onChange={(e) => setShell(e.target.value)} placeholder="/bin/sh" /></label>
      <div className="grid gap-2" aria-label="Ephemeral containers">
        {displayed.map((container) => <div key={container.name} className="rounded-control border border-border-default p-2 text-xs">
          <p className="font-mono break-all">{container.name} · {container.state}</p><p className="text-text-secondary break-all">{container.image}{container.message ? ` · ${container.message}` : ""}</p>
          <Button variant="outline" size="sm" disabled={!available || !capability.canMutate || container.state !== "running" || !shell.trim()} onClick={() => open(container)}>Open terminal · {container.name}</Button>
        </div>)}
      </div>
    </DialogContent>
  </Dialog>;
}
