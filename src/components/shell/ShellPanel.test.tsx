import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShellPanel } from "./ShellPanel";
import { useShellDockStore } from "@/state/shellDockStore";
import { k8s } from "@/lib/k8s";

vi.mock("@tauri-apps/api/core", () => ({ Channel: class { onmessage: unknown; } }));
vi.mock("@/lib/k8s", () => ({ k8s: {
  startPodAttach: vi.fn(async () => "attach-id"),
  podAttachClose: vi.fn(async () => {}),
} }));
// xterm requires a browser canvas. Keep session/start behavior real here.
vi.mock("./ShellTerminalHost", () => ({ ShellTerminalHost: () => null }));

const KEY = { pod: "api-1", namespace: "apps", context: "dev", container: "app", command: ["/bin/sh"] };

function TestDock() {
  const tab = useShellDockStore((s) => s.tabs[0]);
  return <>
    <div aria-label="tab identity">{tab.container} {tab.commandLabel}</div>
    <ShellPanel key={JSON.stringify([tab.session.container, tab.session.command])}
      session={tab.session} containerOptions={[{ name: "app" }, { name: "sidecar" }]}
      onStartSelection={(container: string, command: string[]) => useShellDockStore.getState().replaceSession(tab.id, { container, command })}
    />
  </>;
}

beforeEach(() => {
  vi.clearAllMocks();
  useShellDockStore.setState({ tabs: [], activeTabId: null, isOpen: false, mru: [] });
  useShellDockStore.getState().openSession(KEY);
});

describe("shell selection", () => {
  it("starts the selected container and command and updates the tab identity", async () => {
    render(<TestDock />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "sidecar" } });
    fireEvent.click(screen.getByRole("button", { name: "/bin/bash" }));
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await waitFor(() => expect(k8s.startPodAttach).toHaveBeenCalledWith(
      expect.objectContaining({ container: "sidecar", command: ["/bin/bash"] }), expect.anything(), "dev",
    ));
    expect(screen.getByLabelText("tab identity")).toHaveTextContent("sidecar bash");
    expect(useShellDockStore.getState().mru[0]).toMatchObject({ container: "sidecar", command: ["/bin/bash"] });
  });

  it("preserves quoted arguments and blocks unterminated quotes", async () => {
    render(<TestDock />);
    const input = screen.getByPlaceholderText("command");
    fireEvent.change(input, { target: { value: 'env "A=two words" /bin/bash' } });
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await waitFor(() => expect(k8s.startPodAttach).toHaveBeenCalledWith(
      expect.objectContaining({ command: ["env", "A=two words", "/bin/bash"] }), expect.anything(), "dev",
    ));
    await act(async () => useShellDockStore.getState().tabs[0].session.close());
    vi.mocked(k8s.startPodAttach).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await waitFor(() => expect(k8s.startPodAttach).toHaveBeenCalledWith(
      expect.objectContaining({ command: ["env", "A=two words", "/bin/bash"] }), expect.anything(), "dev",
    ));
    await act(async () => useShellDockStore.getState().tabs[0].session.close());
    fireEvent.change(screen.getByPlaceholderText("command"), { target: { value: 'env "unfinished' } });
    vi.mocked(k8s.startPodAttach).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    expect(k8s.startPodAttach).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/quote/i);
  });
});
