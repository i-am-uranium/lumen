import { useEffect, useRef } from "react";
import { usePaneTarget } from "@/hooks/useMutationCapability";

/** An open approval belongs to its original pane, route and exact target. */
export function useConfirmationTarget(open: boolean, target: string, explicitContext: string | undefined, namespace: string | undefined, onCancel: () => void) {
  const pane = usePaneTarget();
  const context = explicitContext ?? pane.context;
  const identity = JSON.stringify([pane.paneId, pane.url, context, namespace, target]);
  const opened = useRef<string | null>(null);
  if (!open) opened.current = null;
  else if (opened.current === null) opened.current = identity;
  const valid = !open || opened.current === identity;
  useEffect(() => { if (!valid) onCancel(); }, [valid, onCancel]);
  return { context, valid };
}
