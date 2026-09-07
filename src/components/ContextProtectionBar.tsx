import { useState } from "react";
import { Lock, ShieldCheck, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { canMutateContext, contextProtection, protectionErrorMessage } from "@/lib/contextProtection";
import { publishProtection, useMutationCapability } from "@/hooks/useMutationCapability";

export function ContextProtectionBar({ context }: { context: string }) {
  // Remount pending acknowledgements whenever the pane changes context.
  return <ProtectionControls key={context} context={context} />;
}
function ProtectionControls({ context }: { context: string }) {
  const capability = useMutationCapability(context);
  const [pending, setPending] = useState<"unlock" | "unprotect" | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const { status, globalReadOnly, now } = capability;
  const unlocked = status?.protected && canMutateContext(status, context, now);
  const seconds = Math.max(0, Math.ceil(((status?.unlocked_until_ms ?? 0) - now) / 1000));
  const label = globalReadOnly ? "Global read-only" : !status ? capability.reason : status.protected ? unlocked ? `Protected · unlocked ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Protected · locked" : "Unprotected";
  async function change(action: "protect" | "unprotect" | "unlock" | "lock") {
    setBusy(true);
    setActionError(null);
    // Revoke stale UI permission immediately while changing protection.
    publishProtection(context);
    try {
      const next = action === "unlock" ? await contextProtection.unlock(context) : action === "lock" ? await contextProtection.lock(context) : await contextProtection.set(context, action === "protect");
      if (!next || next.context !== context) throw new Error("Protection status unavailable");
      publishProtection(context, next);
      setPending(null);
    } catch (error) {
      setActionError(protectionErrorMessage(error));
      publishProtection(context, undefined, protectionErrorMessage(error));
    } finally { setBusy(false); }
  }
  return (
    <div className="shrink-0 border-b border-border-default bg-surface px-3 py-2 text-[11px] text-text-secondary">
      <div className="flex flex-wrap items-center gap-2">
        {status?.protected ? <ShieldCheck className="size-3.5 text-warning" aria-hidden="true" /> : <ShieldOff className="size-3.5" aria-hidden="true" />}
        <span className="max-w-64 truncate font-mono text-text-primary" title={context}>{context}</span>
        <span role="status" className="mr-auto">{label}</span>
        {!status && !busy && <Button size="sm" variant="outline" onClick={() => void capability.refresh()}>Retry protection status</Button>}
        {status && !status.protected && <Button size="sm" variant="outline" disabled={busy} onClick={() => void change("protect")}>Protect context</Button>}
        {status?.protected && !unlocked && <Button size="sm" variant="outline" disabled={busy || globalReadOnly} onClick={() => setPending("unlock")}>Unlock for 10 minutes</Button>}
        {unlocked && <Button size="sm" variant="outline" disabled={busy} onClick={() => void change("lock")}><Lock className="size-3" />Lock now</Button>}
        {status?.protected && <Button size="sm" variant="ghost" disabled={busy || globalReadOnly} onClick={() => setPending("unprotect")}>Remove protection</Button>}
      </div>
      {(actionError || capability.error) && <p role="alert" className="mt-1 text-danger">{actionError || capability.error}</p>}
      <ConfirmActionDialog open={pending !== null} title={pending === "unlock" ? "Unlock protected context" : "Remove context protection"} description={pending === "unlock" ? "Allow cluster changes and pod shells in this context for 10 minutes. Every pane showing this same context shares this temporary grant. You can lock it again at any time." : "This context will allow changes without a temporary unlock. Protection stays off until you enable it again."} target={context} confirmText={context} confirmLabel={pending === "unlock" ? "Unlock for 10 minutes" : "Remove protection"} busy={busy || globalReadOnly} intent="warning" onCancel={() => setPending(null)} onConfirm={() => pending && void change(pending)} />
    </div>
  );
}
