import { k8s, type ResourceDetail } from "@/lib/k8s";
import { captureLogSnapshot } from "@/state/logStream";

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
type Deps = { getResource: typeof k8s.getResource; capture: typeof captureLogSnapshot; now: () => Date };
export async function captureIncidentLogEvidence(request: Request, deps: Deps = { getResource: k8s.getResource, capture: captureLogSnapshot, now: () => new Date() }): Promise<LogEvidence> {
  const base = { context: request.context, namespace: request.namespace, pod: request.pod, podUid: request.podUid, container: request.container, instance: request.previous ? "previous" as const : "current" as const, capturedAt: deps.now().toISOString(), lineLimit: LOG_EVIDENCE_MAX_LINES, charLimit: LOG_EVIDENCE_MAX_CHARS, truncated: false, text: "", included: false };
  if (!request.podUid) return { ...base, status: "unavailable", note: "Pod UID unavailable; name-only logs were not captured." };
  try {
    const before = resourceUid(await deps.getResource(request.namespace, "pod", request.pod, request.context));
    if (before !== request.podUid) return { ...base, status: "replaced", note: "Pod identity changed before capture; logs were excluded." };
    const lines = await deps.capture({ namespace: request.namespace, pod: request.pod, context: request.context, container: request.container, previous: request.previous, tailLines: LOG_EVIDENCE_MAX_LINES + 1 });
    const after = resourceUid(await deps.getResource(request.namespace, "pod", request.pod, request.context));
    if (after !== before) return { ...base, status: "replaced", note: "Pod identity changed during capture; logs were excluded." };
    const joined = lines.slice(0, LOG_EVIDENCE_MAX_LINES).join("\n"); const text = joined.slice(0, LOG_EVIDENCE_MAX_CHARS);
    return { ...base, status: "captured", included: true, text, truncated: lines.length > LOG_EVIDENCE_MAX_LINES || joined.length > LOG_EVIDENCE_MAX_CHARS, note: request.previous ? "Retained previous logs; exact terminated container instance identity is unavailable." : "Current logs captured for the verified pod UID." };
  } catch { return { ...base, status: "error", note: "Log capture failed or retained logs were unavailable." }; }
}
