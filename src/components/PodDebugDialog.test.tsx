import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { PodDebugDialog } from "./PodDebugDialog";
import { k8s } from "@/lib/k8s";
import type { DebugTarget } from "@/lib/podDebug";
const control = vi.hoisted(() => ({ allowed: true, open: vi.fn() }));
vi.mock("@/hooks/useMutationCapability", () => ({ useMutationCapability: () => ({ canMutate: control.allowed, reason: "Protected context is locked" }) }));
vi.mock("@/hooks/useShellDock", () => ({ useShellDock: () => ({ openSession: control.open }) }));
vi.mock("@/lib/k8s", () => ({ k8s: { getDebugTarget: vi.fn(), createDebugContainer: vi.fn() } }));
const selection = { context: "dev", namespace: "apps", pod: "api" };
const snapshot: DebugTarget = { ...selection, pod_uid: "uid-one", phase: "Running", deleting: false, containers: ["app", "sidecar"], ephemeral_containers: [] };
beforeEach(() => { vi.clearAllMocks(); control.allowed = true; vi.mocked(k8s.getDebugTarget).mockResolvedValue(structuredClone(snapshot)); });
function setup() {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const close = vi.fn();
  return { query, close, ...render(<QueryClientProvider client={query}><PodDebugDialog selection={selection} onClose={close} /></QueryClientProvider>) };
}
it("loads captured identity without mutation and blocks creation while locked", async () => {
  control.allowed = false; setup();
  expect(await screen.findByText(/Pod UID: uid-one/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create debug container" })).toBeDisabled();
  expect(k8s.createDebugContainer).not.toHaveBeenCalled();
  expect(screen.getByText(/Closing a terminal does not remove/)).toBeInTheDocument();
});
it("validates command and retries the same captured request after timeout", async () => {
  const user = userEvent.setup(); setup();
  await screen.findByText(/Pod UID: uid-one/);
  await user.clear(screen.getByLabelText("Container command (JSON argument array)"));
  await user.type(screen.getByLabelText("Container command (JSON argument array)"), 'wrong');
  await user.click(screen.getByRole("button", { name: "Create debug container" }));
  expect(k8s.createDebugContainer).not.toHaveBeenCalled();
  await user.clear(screen.getByLabelText("Container command (JSON argument array)"));
  await user.paste('["sleep", "90"]');
  await user.selectOptions(screen.getByLabelText("Target container"), "sidecar");
  await user.selectOptions(screen.getByLabelText("Unprivileged profile"), "baseline");
  vi.mocked(k8s.createDebugContainer).mockRejectedValue(new Error("Timed out. Retry same container."));
  await user.click(screen.getByRole("button", { name: "Create debug container" }));
  await screen.findByText("Timed out. Retry same container.");
  const first = vi.mocked(k8s.createDebugContainer).mock.calls[0][0];
  expect(first).toMatchObject({ ...selection, pod_uid: "uid-one", target_container: "sidecar", profile: "baseline", command: ["sleep", "90"] });
  expect(screen.getByLabelText("Diagnostic image")).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Retry same container" }));
  await waitFor(() => expect(k8s.createDebugContainer).toHaveBeenCalledTimes(2));
  expect(vi.mocked(k8s.createDebugContainer).mock.calls[1][0]).toEqual(first);
});
it("reopens a running ephemeral container in the existing terminal with its pod UID", async () => {
  vi.mocked(k8s.getDebugTarget).mockResolvedValue({ ...snapshot, ephemeral_containers: [
    { name: "lumen-debug-existing", image: "busybox", target_container: "app", state: "running", message: null },
    { name: "lumen-debug-ended", image: "busybox", target_container: "app", state: "terminated", message: "Exited with code 0. Cannot restart." },
  ] });
  const user = userEvent.setup(); const { close } = setup();
  await screen.findByText(/Pod UID: uid-one/);
  expect(screen.getByRole("button", { name: "Open terminal · lumen-debug-ended" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Open terminal · lumen-debug-existing" }));
  expect(control.open).toHaveBeenCalledWith({ ...selection, podUid: "uid-one", container: "lumen-debug-existing", command: ["/bin/sh"] });
  expect(close).toHaveBeenCalled(); expect(k8s.createDebugContainer).not.toHaveBeenCalled();
});
it("refuses a replaced pod rather than adopting its UID", async () => {
  const { query } = setup(); await screen.findByText(/Pod UID: uid-one/);
  await act(async () => { query.setQueryData(["pod-debug", "dev", "apps", "api"], { ...snapshot, pod_uid: "replacement" }); });
  expect(await screen.findByRole("alert")).toHaveTextContent("The pod was replaced");
  expect(screen.getByRole("button", { name: "Create debug container" })).toBeDisabled();
});
it("selection changes and late creation replies cannot open or retarget a terminal", async () => {
  let resolve!: (value: any) => void;
  vi.mocked(k8s.createDebugContainer).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const user = userEvent.setup(); const mounted = setup(); await screen.findByText(/Pod UID: uid-one/);
  await user.click(screen.getByRole("button", { name: "Create debug container" }));
  mounted.rerender(<QueryClientProvider client={mounted.query}><PodDebugDialog selection={{ context: "prod", namespace: "other", pod: "new" }} onClose={mounted.close} /></QueryClientProvider>);
  expect(screen.getByText(/dev \/ apps \/ api/)).toBeInTheDocument();
  mounted.unmount();
  await act(async () => { resolve({ reused: false, container: { name: "lumen-debug-test", state: "running" } }); });
  expect(control.open).not.toHaveBeenCalled();
});
