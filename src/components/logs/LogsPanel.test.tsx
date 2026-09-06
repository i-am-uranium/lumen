import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import { LogsPanel } from "./LogsPanel";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ Channel: class { onmessage?: (event: unknown) => void; }, invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("./LogsToolbar", () => ({ LogsToolbar: ({ onPreviousToggle, onDownload }: { onPreviousToggle: () => void; onDownload: () => void }) => <><button onClick={onPreviousToggle}>previous</button><button onClick={onDownload}>download</button></> }));
vi.mock("./LogsRowList", () => ({ LogsRowList: () => null }));

it("recreates streams when the pod changes", async () => {
  vi.mocked(invoke).mockClear();
  const props = { ctx: "dev", namespace: "ns", pod: "api-1", containers: [{ name: "app", kind: "regular" as const }], resourceName: "api" };
  const view = render(<LogsPanel {...props} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("stream_logs", expect.objectContaining({ selector: expect.objectContaining({ pod_name: "api-1" }) })));
  view.rerender(<LogsPanel {...props} pod="api-2" />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("stream_logs", expect.objectContaining({ selector: expect.objectContaining({ pod_name: "api-2" }) })));
  view.unmount();
});

it("switches to a newly started previous-log stream", async () => {
  vi.mocked(invoke).mockClear();
  const view = render(<LogsPanel ctx="dev" namespace="ns" pod="api" containers={[{ name: "app", kind: "regular" }]} resourceName="api" />);
  fireEvent.click(screen.getByText("previous"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("stream_logs", expect.objectContaining({ selector: expect.objectContaining({ previous: true, since_seconds: null }) })));
  view.unmount();
});

it("reports download permission errors without creating an empty file", async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockClear();
  const createUrl = vi.fn(() => "blob:logs");
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const view = render(<LogsPanel ctx="dev" namespace="ns" pod="api" containers={[]} resourceName="api" />);
  try {
    fireEvent.click(screen.getByText("download"));
    const args = vi.mocked(invoke).mock.calls.find(([command]) => command === "stream_logs")![1] as { channel: { onmessage: (event: unknown) => void } };
    act(() => args.channel.onmessage({ type: "status", pod: "api", status: "error", message: "forbidden" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("forbidden"));
    expect(createUrl).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("stop_stream", expect.anything());
  } finally {
    view.unmount();
    click.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
