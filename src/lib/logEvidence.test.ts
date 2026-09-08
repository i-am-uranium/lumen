import { describe, expect, it, vi } from "vitest";
import { captureIncidentLogEvidence, resourceUid } from "./logEvidence";
const detail = (uid?: string) => ({ yaml: uid ? `metadata:\n  name: api\n  uid: ${uid}\nspec: {}` : "metadata:\n  name: api", summary: {}, owner_refs: [] }) as never;
const request = { context: "prod", namespace: "payments", pod: "api", podUid: "uid-1", container: "worker", previous: true };
describe("log evidence", () => {
  it("extracts top-level metadata UID", () => expect(resourceUid(detail("uid-1"))).toBe("uid-1"));
  it("does not capture without UID", async () => { const capture = vi.fn(); const result = await captureIncidentLogEvidence({ ...request, podUid: null }, { getResource: vi.fn(), capture, now: () => new Date(0) }); expect(result.status).toBe("unavailable"); expect(capture).not.toHaveBeenCalled(); });
  it("rejects replacement across capture", async () => { const getResource = vi.fn().mockResolvedValueOnce(detail("uid-1")).mockResolvedValueOnce(detail("uid-2")); const result = await captureIncidentLogEvidence(request, { getResource, capture: vi.fn().mockResolvedValue(["old logs"]), now: () => new Date(0) }); expect(result.status).toBe("replaced"); expect(result.text).toBe(""); });
  it("bounds oversized captures", async () => { const result = await captureIncidentLogEvidence(request, { getResource: vi.fn().mockResolvedValue(detail("uid-1")), capture: vi.fn().mockResolvedValue(Array.from({ length: 250 }, () => "x".repeat(200))), now: () => new Date(0) }); expect(result.truncated).toBe(true); expect(result.text.length).toBeLessThanOrEqual(20_000); });
  it("returns redaction-safe capture errors", async () => { const result = await captureIncidentLogEvidence(request, { getResource: vi.fn().mockResolvedValue(detail("uid-1")), capture: vi.fn().mockRejectedValue(new Error("token=secret")), now: () => new Date(0) }); expect(result.status).toBe("error"); expect(JSON.stringify(result)).not.toContain("secret"); });
});
