import { useEffect, useState } from "react";
import { create } from "zustand";
import { useOptionalPaneId } from "@/components/PaneContext";
import { usePanesStore } from "@/state/panes";
import { useUiSettings } from "@/state/uiSettings";
import { canMutateContext, contextProtection, protectionErrorMessage, type ContextProtection } from "@/lib/contextProtection";

type Entry = { status?: ContextProtection; error?: string };
export const useContextProtectionStore = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));
const pending = new Map<string, Promise<void>>();
const versions = new Map<string, number>();
export function publishProtection(context: string, status?: ContextProtection, error?: string) {
  versions.set(context, (versions.get(context) ?? 0) + 1);
  useContextProtectionStore.setState((s) => ({ entries: { ...s.entries, [context]: { status, error } } }));
}
export function refreshProtection(context: string): Promise<void> {
  if (!context) return Promise.resolve();
  const existing = pending.get(context);
  if (existing) return existing;
  const version = versions.get(context) ?? 0;
  const request = Promise.resolve().then(() => contextProtection.get(context)).then((status) => {
    if ((versions.get(context) ?? 0) !== version) return;
    if (!status || status.context !== context || typeof status.protected !== "boolean") throw new Error("Protection status is unavailable");
    publishProtection(context, status);
  }).catch((error: unknown) => {
    if ((versions.get(context) ?? 0) === version) publishProtection(context, undefined, protectionErrorMessage(error));
  }).finally(() => { pending.delete(context); });
  pending.set(context, request);
  return request;
}
export function contextFromPaneUrl(url: string): string {
  const match = /^\/cluster\/([^/?]+)/.exec(url);
  try { return match ? decodeURIComponent(match[1]) : ""; } catch { return ""; }
}
export function usePaneTarget() {
  const paneId = useOptionalPaneId();
  const url = usePanesStore((s) => s.panes.find((pane) => pane.id === paneId)?.url ?? "");
  return { paneId, url, context: contextFromPaneUrl(url) };
}
export function useMutationCapability(explicitContext?: string) {
  const pane = usePaneTarget();
  const context = explicitContext ?? pane.context;
  const entry = useContextProtectionStore((s) => s.entries[context]);
  const globalReadOnly = useUiSettings((s) => s.readOnly);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!context) return;
    void refreshProtection(context);
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    const poll = window.setInterval(() => { void refreshProtection(context); }, 5000);
    const focus = () => { setNow(Date.now()); void refreshProtection(context); };
    window.addEventListener("focus", focus);
    return () => { window.clearInterval(timer); window.clearInterval(poll); window.removeEventListener("focus", focus); };
  }, [context]);
  const canMutate = !globalReadOnly && canMutateContext(entry?.status, context, now);
  const reason = globalReadOnly ? "Global read-only mode is enabled" : entry?.error ? "Protection status unavailable — changes blocked" : !entry?.status ? "Checking context protection" : !canMutate ? "Protected context is locked" : "Changes allowed";
  return { context, status: entry?.status, error: entry?.error, canMutate, reason, globalReadOnly, now, refresh: () => refreshProtection(context) };
}
