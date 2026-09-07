import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { assertContextMutation, canMutateContext } from "./contextProtection";
import { useUiSettings } from "@/state/uiSettings";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
describe("context mutation authorization", () => {
  beforeEach(() => { vi.clearAllMocks(); useUiSettings.setState({ readOnly: false }); });
  it("requires an explicit context and never falls back to the focused cluster", async () => {
    await expect(assertContextMutation(undefined)).rejects.toThrow(/context/i);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("allows dev independently while prod is protected, then rejects an expired grant", async () => {
    vi.mocked(invoke).mockImplementation(async (_command, args) => ({ context: (args as any).context, protected: (args as any).context === "prod", unlocked_until_ms: null, can_mutate: (args as any).context !== "prod" }));
    await expect(assertContextMutation("prod")).rejects.toThrow(/locked/i);
    await expect(assertContextMutation("dev")).resolves.toBeUndefined();
    expect(canMutateContext({ context: "prod", protected: true, unlocked_until_ms: 100, can_mutate: true }, "prod", 101)).toBe(false);
  });
  it("fails closed for unavailable or mismatched native status and honors global read-only", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("offline"));
    await expect(assertContextMutation("prod")).rejects.toThrow("offline");
    vi.mocked(invoke).mockResolvedValue({ context: "dev", protected: false, can_mutate: true, unlocked_until_ms: null });
    await expect(assertContextMutation("prod")).rejects.toThrow(/locked|unavailable/i);
    useUiSettings.setState({ readOnly: true });
    await expect(assertContextMutation("dev")).rejects.toThrow(/read-only/i);
  });
});
