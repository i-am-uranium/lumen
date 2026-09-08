import { describe, expect, it, vi } from "vitest";
import { captureIncidentLogEvidence, resourceUid } from "./logEvidence";
const detail = (uid?: string) => ({ yaml: uid ? `metadata:\n  name: api\n  uid: ${uid}\nspec: {}` : "metadata:\n  name: api", summary: {}, owner_refs: [] }) as never;
const request = { context: "prod", namespace: "payments", pod: "api", podUid: "uid-1", container: "worker", previous: true };
describe("log evidence", () => {
  it("extracts top-level metadata UID", () => expect(resourceUid(detail("uid-1"))).toBe("uid-1"));
  it("does not capture without UID", async () => { const capture = vi.fn(); const result = await captureIncidentLogEvidence({ ...request, podUid: null }, { capture, now: () => new Date(0) }); expect(result.status).toBe("unavailable"); expect(capture).not.toHaveBeenCalled(); });
  it("reports native identity replacement safely", async () => { const result = await captureIncidentLogEvidence(request, { capture: vi.fn().mockRejectedValue(new Error("pod identity changed during capture")), now: () => new Date(0) }); expect(result.status).toBe("replaced"); expect(result.text).toBe(""); });
  it("bounds and redacts oversized captures", async () => { const raw = `Authorization: Bearer synthetic-secret\n${"x".repeat(25_000)}`; const result = await captureIncidentLogEvidence(request, { capture: vi.fn().mockResolvedValue({ text: raw, truncated: true, bytes: 20_000 }), now: () => new Date(0) }); expect(result.truncated).toBe(true); expect(result.text.length).toBeLessThanOrEqual(20_000); expect(result.text).not.toContain("synthetic-secret"); });
  it("returns redaction-safe capture errors", async () => { const result = await captureIncidentLogEvidence(request, { capture: vi.fn().mockRejectedValue(new Error("token=secret")), now: () => new Date(0) }); expect(result.status).toBe("error"); expect(JSON.stringify(result)).not.toContain("secret"); });
});
