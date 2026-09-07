import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextProtectionBar } from "./ContextProtectionBar";
import { contextProtection } from "@/lib/contextProtection";
import { useContextProtectionStore } from "@/hooks/useMutationCapability";
import { useUiSettings } from "@/state/uiSettings";
vi.mock("@/lib/contextProtection", async (original) => ({ ...await original<any>(), contextProtection: { get: vi.fn(), set: vi.fn(), unlock: vi.fn(), lock: vi.fn() } }));
const status = (context: string, protectedContext = true, until: number | null = null) => ({ context, protected: protectedContext, unlocked_until_ms: until, can_mutate: !protectedContext || !!until });
beforeEach(() => { vi.clearAllMocks(); useContextProtectionStore.setState({ entries: {} }); useUiSettings.setState({ readOnly: false }); });
describe("context protection controls", () => {
  it("isolates prod and dev and requires exact context acknowledgement to unlock", async () => {
    vi.mocked(contextProtection.get).mockImplementation(async (ctx) => status(ctx, ctx === "prod"));
    vi.mocked(contextProtection.unlock).mockResolvedValue(status("prod", true, Date.now() + 600_000));
    render(<><section aria-label="prod pane"><ContextProtectionBar context="prod" /></section><section aria-label="dev pane"><ContextProtectionBar context="dev" /></section></>);
    const prod = within(screen.getByRole("region", { name: "prod pane" }));
    const dev = within(screen.getByRole("region", { name: "dev pane" }));
    await waitFor(() => expect(prod.getByText("Protected · locked")).toBeInTheDocument());
    expect(dev.getByText("Unprotected")).toBeInTheDocument();
    await userEvent.click(prod.getByRole("button", { name: "Unlock for 10 minutes" }));
    const dialog = within(screen.getByRole("dialog"));
    await userEvent.type(dialog.getByRole("textbox"), "dev");
    expect(dialog.getByRole("button", { name: "Unlock for 10 minutes" })).toBeDisabled();
    await userEvent.clear(dialog.getByRole("textbox"));
    await userEvent.type(dialog.getByRole("textbox"), "prod");
    await userEvent.click(dialog.getByRole("button", { name: "Unlock for 10 minutes" }));
    await waitFor(() => expect(prod.getByRole("button", { name: "Lock now" })).toBeInTheDocument());
    expect(dev.getByText("Unprotected")).toBeInTheDocument();
  });
  it("fails closed on status errors with a retry control", async () => {
    vi.mocked(contextProtection.get).mockRejectedValue(new Error("IPC unavailable"));
    render(<ContextProtectionBar context="prod" />);
    await waitFor(() => expect(screen.getByText(/Protection status unavailable/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Unlock for 10 minutes" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry protection status" })).toBeEnabled();
  });
  it("expires an unlock in the visible UI even before the native poll returns", async () => {
    vi.useFakeTimers();
    vi.mocked(contextProtection.get).mockResolvedValue(status("prod", true, Date.now() + 2000));
    render(<ContextProtectionBar context="prod" />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Lock now" })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText("Protected · locked")).toBeInTheDocument();
    vi.useRealTimers();
  });
});

it("shows structured native errors and keeps permission blocked after a failed unlock", async () => {
  vi.mocked(contextProtection.get).mockResolvedValue(status("prod"));
  vi.mocked(contextProtection.unlock).mockRejectedValue({ kind: "PermissionDenied", message: "The context was disconnected. Reconnect before unlocking." });
  render(<ContextProtectionBar context="prod" />);
  await userEvent.click(await screen.findByRole("button", { name: "Unlock for 10 minutes" }));
  const dialog = within(screen.getByRole("dialog"));
  await userEvent.type(dialog.getByRole("textbox"), "prod");
  await userEvent.click(dialog.getByRole("button", { name: "Unlock for 10 minutes" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Reconnect before unlocking"));
  expect(screen.queryByRole("button", { name: "Lock now" })).not.toBeInTheDocument();
});
it("relocks an unlocked context and requires typed acknowledgement to permanently remove protection", async () => {
  vi.mocked(contextProtection.get).mockResolvedValue(status("prod", true, Date.now() + 600_000));
  vi.mocked(contextProtection.lock).mockResolvedValue(status("prod"));
  vi.mocked(contextProtection.set).mockResolvedValue(status("prod", false));
  render(<ContextProtectionBar context="prod" />);
  await userEvent.click(await screen.findByRole("button", { name: "Lock now" }));
  await waitFor(() => expect(screen.getByText("Protected · locked")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Remove protection" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByRole("button", { name: "Remove protection" })).toBeDisabled();
  await userEvent.type(dialog.getByRole("textbox"), "prod");
  await userEvent.click(dialog.getByRole("button", { name: "Remove protection" }));
  await waitFor(() => expect(screen.getByText("Unprotected")).toBeInTheDocument());
});
