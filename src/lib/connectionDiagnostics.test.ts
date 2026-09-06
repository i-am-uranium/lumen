import { describe, expect, it, vi } from "vitest";
import { classifyConnectionError, diagnoseConnection } from "./connectionDiagnostics";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("connection diagnostics", () => {
  it.each([
    ["Unauthorized: exec credential expired", "authentication"],
    ["Forbidden: user cannot list pods", "permission_denied"],
    ["x509: certificate signed by unknown authority", "tls"],
    ["certificate expired", "tls"],
    ["dial tcp: connection refused", "network"],
    ["unexpected failure", "unknown"],
  ])("classifies %s without returning raw details", (error, status) => {
    const result = classifyConnectionError(`${error} token=super-secret`);
    expect(result.status).toBe(status);
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("does not claim a local permission failure proves cluster identity", () => {
    const result = classifyConnectionError("permission denied opening local credential cache");
    expect(result.status).toBe("permission_denied");
    expect(result.guidance).not.toContain("identity connected");
    expect(result.guidance).toContain("local file");
  });

  it("uses the separate bounded native command", async () => {
    vi.mocked(invoke).mockResolvedValue({ status: "ready_to_retry" });
    await diagnoseConnection("dev");
    expect(invoke).toHaveBeenCalledWith("diagnose_connection", { context: "dev" });
  });
});
