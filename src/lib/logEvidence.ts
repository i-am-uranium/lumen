import { k8s, type ResourceDetail } from "@/lib/k8s";
import { redactIncidentReportText } from "@/lib/incidentReport";

export const LOG_EVIDENCE_MAX_LINES = 200;
export const LOG_EVIDENCE_MAX_CHARS = 20_000;
export type LogEvidence = { status: "captured" | "unavailable" | "error" | "replaced"; context: string; namespace: string; pod: string; podUid: string | null; container: string; instance: "current" | "previous"; capturedAt: string; lineLimit: number; charLimit: number; truncated: boolean; text: string; included: boolean; note: string };
export function resourceUid(detail?: ResourceDetail): string | null {
  if (!detail?.yaml) return null;
  const lines = detail.yaml.split(/\r?\n/); let metadata = false;
  for (const line of lines) { if (/^metadata:\s*$/.test(line)) { metadata = true; continue; } if (metadata && /^\S/.test(line)) break; const match = metadata ? line.match(/^\s{2}uid:\s*["']?([^"'\s]+)["']?\s*$/) : null; if (match) return match[1]; }
  return null;
}
type Request = { context: string; namespace: string; pod: string; podUid: string | null; container: string; previous: boolean };
type Deps = { capture: typeof k8s.captureIncidentLogs; now: () => Date };
export function boundLogEvidenceText(value: string) { return value.split(/\r?\n/).slice(0, LOG_EVIDENCE_MAX_LINES).join("\n").slice(0, LOG_EVIDENCE_MAX_CHARS); }
export async function captureIncidentLogEvidence(request: Request, deps: Deps = { capture: k8s.captureIncidentLogs, now: () => new Date() }): Promise<LogEvidence> {
  const base = { context: request.context, namespace: request.namespace, pod: request.pod, podUid: request.podUid, container: request.container, instance: request.previous ? "previous" as const : "current" as const, capturedAt: deps.now().toISOString(), lineLimit: LOG_EVIDENCE_MAX_LINES, charLimit: LOG_EVIDENCE_MAX_CHARS, truncated: false, text: "", included: false };
  if (!request.podUid) return { ...base, status: "unavailable", note: "Pod UID unavailable; name-only logs were not captured." };
  try {
    const capture = await deps.capture(request.context, request.namespace, request.pod, request.podUid, request.container, request.previous);
    const redacted = redactIncidentReportText(capture.text);
    const text = boundLogEvidenceText(redacted);
    return { ...base, status: "captured", included: true, text, truncated: capture.truncated || redacted !== text, note: request.previous ? "Retained previous logs; exact terminated container instance identity is unavailable." : "Current log selection captured; exact container instance identity is unavailable." };
  } catch (error) { const identityChanged = String(error).toLowerCase().includes("identity changed"); return { ...base, status: identityChanged ? "replaced" : "error", note: identityChanged ? "Pod identity changed during bounded capture; logs were excluded." : "Log capture failed, timed out, or retained logs were unavailable." }; }
}
