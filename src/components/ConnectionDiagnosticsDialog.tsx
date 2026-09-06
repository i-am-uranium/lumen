import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  classifyConnectionError,
  diagnoseConnection,
  type ConnectionDiagnostic,
} from "@/lib/connectionDiagnostics";

type Props = {
  open: boolean;
  context: string | null;
  observedError?: unknown;
  retrying: boolean;
  onClose: () => void;
  onRetry: () => void;
};

export function ConnectionDiagnosticsDialog({ open, context, observedError, retrying, onClose, onRetry }: Props) {
  const requestKey = context ?? "__no_context__";
  const [diagnosticState, setDiagnosticState] = useState<{
    key: string;
    value: ConnectionDiagnostic;
  } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setDiagnosticState(null);
    setLoadingKey(requestKey);
    setFailedKey(null);
    void diagnoseConnection(context)
      .then((result) => {
        if (current) setDiagnosticState({ key: requestKey, value: result });
      })
      .catch(() => {
        if (current) {
          setDiagnosticState(null);
          setFailedKey(requestKey);
        }
      })
      .finally(() => {
        if (current) setLoadingKey(null);
      });
    return () => {
      current = false;
    };
  }, [context, open, requestKey]);

  const diagnostic = diagnosticState?.key === requestKey ? diagnosticState.value : null;
  const loading = open && (loadingKey === requestKey || (!diagnostic && failedKey !== requestKey));
  const inspectionFailed = failedKey === requestKey;
  const failure = observedError ? classifyConnectionError(observedError) : null;
  const canRetry = !loading && (diagnostic?.status === "ready_to_retry" || failure !== null);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="border-border-default bg-surface text-text-primary">
        <DialogHeader>
          <DialogTitle>Connection diagnostics{context ? ` · ${context}` : ""}</DialogTitle>
          <DialogDescription>
            Read-only inspection. This inspection does not execute credential tools.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {loading && <p>Inspecting local configuration…</p>}
          {inspectionFailed && <p className="text-danger">Local configuration inspection could not be completed.</p>}
          {failure && (
            <div className="rounded-control border border-warning/30 bg-warning/10 p-3">
              <h3 className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" />{failure.title}</h3>
              <p className="mt-1 text-xs text-text-secondary">{failure.guidance}</p>
            </div>
          )}
          {diagnostic && (
            <div className="space-y-2 rounded-control border border-border-default bg-elevated p-3">
              <p>{diagnostic.message}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-text-muted">Config source</dt><dd className="break-all font-mono">{diagnostic.config_path}</dd>
                {diagnostic.credential_executable && <><dt className="text-text-muted">Credential tool</dt><dd className="font-mono">{diagnostic.credential_executable} ({diagnostic.credential_executable_available ? "available" : "missing"})</dd></>}
              </dl>
              {diagnostic.single_source_only && <p className="text-xs text-text-muted">This version inspects the first path only; kubeconfig source merging is not yet supported.</p>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button disabled={!canRetry || retrying} onClick={onRetry}>
            <RefreshCw className={retrying ? "size-4 animate-spin" : "size-4"} />
            {retrying ? "Retrying…" : "Retry connection"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
