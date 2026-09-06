import { act, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ShellTerminalHost } from "./ShellTerminalHost";
import { useShellDockStore } from "@/state/shellDockStore";
import { k8s } from "@/lib/k8s";

vi.mock("@tauri-apps/api/core", () => ({ Channel: class { onmessage: unknown; } }));
vi.mock("@/lib/k8s", () => ({ k8s: {
  startPodAttach: vi.fn(), podAttachClose: vi.fn(async () => {}),
} }));
// Keep the real host effect and session lifecycle; only replace browser canvas APIs.
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24;
  loadAddon() {} open() {} write() {} dispose() {}
  onData() { return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  useShellDockStore.setState({ tabs: [], activeTabId: null, isOpen: false, mru: [] });
});

it("does not execute a fast replacement command again when its terminal mounts", async () => {
  vi.mocked(k8s.startPodAttach).mockImplementation(async (_opts, channel) => {
    channel.onmessage({ kind: "closed", exit_code: 0, message: null });
    return "completed-command";
  });
  const id = useShellDockStore.getState().openSession({ context: "dev", namespace: "apps", pod: "api", container: "app", command: ["/bin/sh"] });
  await act(async () => useShellDockStore.getState().replaceSession(id, { container: "app", command: ["touch", "/tmp/once"] }));
  const session = useShellDockStore.getState().tabs[0].session;
  expect(session.getState()).toBe("exited");
  render(<ShellTerminalHost session={session} />);
  await act(async () => {});
  expect(k8s.startPodAttach).toHaveBeenCalledTimes(1);
});
