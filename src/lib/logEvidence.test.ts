import { k8s } from "./k8s";
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

describe("bounded native capture contract", () => {
  it.each([false, true])("passes captured UID, context, container and previous=%s to the single IPC", async previous => {
    const capture = vi.fn().mockResolvedValue({ text: "finite EOF", truncated: false, bytes: 10 });
    const result = await captureIncidentLogEvidence({ ...request, previous }, { capture, now: () => new Date(0) });
    expect(capture).toHaveBeenCalledExactlyOnceWith("prod", "payments", "api", "uid-1", "worker", previous);
    expect(result).toMatchObject({ status: "captured", text: "finite EOF", included: true, truncated: false, podUid: "uid-1", instance: previous ? "previous" : "current" });
  });
  it("accepts actual empty EOF as captured evidence", async () => {
    const capture = vi.fn().mockResolvedValue({ text: "", truncated: false, bytes: 0 });
    expect(await captureIncidentLogEvidence(request, { capture, now: () => new Date(0) })).toMatchObject({ status: "captured", included: true, text: "", truncated: false });
  });
  it.each(["Timed out during client startup", "Timed out reading pre UID", "Timed out reading post UID", "403 token=synthetic-secret"])("excludes native operation failure: %s", async failure => {
    const capture = vi.fn().mockRejectedValue(new Error(failure));
    const result = await captureIncidentLogEvidence(request, { capture, now: () => new Date(0) });
    expect(result).toMatchObject({ status: "error", included: false, text: "" });
    expect(result.note).not.toContain(failure);
  });
  it("waits for the native deadline result without performing separate UID fetches", async () => {
    let reject!: (reason: Error) => void;
    const capture = vi.fn().mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const operation = captureIncidentLogEvidence(request, { capture, now: () => new Date(0) });
    expect(capture).toHaveBeenCalledTimes(1);
    reject(new Error("native five-second deadline expired"));
    expect(await operation).toMatchObject({ status: "error", included: false });
  });
  it("does not mark pure redaction as truncation", async () => {
    const capture = vi.fn().mockResolvedValue({ text: "Bearer short-secret", truncated: false, bytes: 19 });
    expect(await captureIncidentLogEvidence(request, { capture, now: () => new Date(0) })).toMatchObject({ text: "Bearer [REDACTED]", truncated: false });
  });
});

it("retains native byte-cap truncation even when returned text fits frontend limits", async () => {
  const capture = vi.fn().mockResolvedValue({ text: "finite prefix", truncated: true, bytes: 20000 });
  expect(await captureIncidentLogEvidence(request, { capture, now: () => new Date(0) })).toMatchObject({ status: "captured", text: "finite prefix", truncated: true });
});

it("the default helper uses one native capture and no external UID reads", async () => {
  const capture = vi.spyOn(k8s, "captureIncidentLogs").mockResolvedValue({ text: "EOF", truncated: false, bytes: 3 });
  const getResource = vi.spyOn(k8s, "getResource").mockRejectedValue(new Error("external UID reads must not run"));
  try {
    expect(await captureIncidentLogEvidence(request)).toMatchObject({ status: "captured", text: "EOF" });
    expect(capture).toHaveBeenCalledExactlyOnceWith("prod", "payments", "api", "uid-1", "worker", true);
    expect(getResource).not.toHaveBeenCalled();
  } finally { capture.mockRestore(); getResource.mockRestore(); }
});
