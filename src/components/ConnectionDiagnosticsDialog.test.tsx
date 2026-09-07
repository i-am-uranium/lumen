import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionDiagnosticsDialog } from "./ConnectionDiagnosticsDialog";
import { diagnoseConnection } from "@/lib/connectionDiagnostics";

vi.mock("@/lib/connectionDiagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectionDiagnostics")>()),
  diagnoseConnection: vi.fn(),
}));

describe("ConnectionDiagnosticsDialog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("shows ordered sources, winning definitions and ignored duplicates", async () => {
    vi.mocked(diagnoseConnection).mockResolvedValue({
      context: "dev", config_path: "/configs/second", status: "ready_to_retry",
      credential_executable: null, credential_executable_available: null,
      message: "Configuration inspection passed.", single_source_only: false,
      sources: [{ path: "/configs/first", exists: true }, { path: "/configs/missing", exists: false }, { path: "/configs/second", exists: true }],
      context_sources: { context: "/configs/second", cluster: "/configs/first" },
      duplicate_definitions: [{ kind: "cluster", name: "shared", source: "/configs/second", shadowed: true }],
    });
    render(<ConnectionDiagnosticsDialog open context="dev" retrying={false} onClose={() => undefined} onRetry={() => undefined} />);
    expect(await screen.findByText(/first definition wins/)).toBeInTheDocument();
    expect(screen.getByText(/missing · skipped/)).toBeInTheDocument();
    expect(screen.getByText("Duplicate definitions ignored")).toBeInTheDocument();
    expect(screen.getByText(/cluster “shared” in/)).toBeInTheDocument();
    expect(screen.queryByText(/first path only/)).not.toBeInTheDocument();
  });

  it("renders safe permission guidance and retries after remediation", async () => {
    vi.mocked(diagnoseConnection).mockResolvedValue({
      context: "dev",
      config_path: "/tmp/config",
      status: "ready_to_retry",
      credential_executable: null,
      credential_executable_available: null,
      message: "Configuration inspection passed. Retry to test actual cluster access.",
      single_source_only: true,
    });
    const retry = vi.fn();
    render(
      <ConnectionDiagnosticsDialog
        open
        context="dev"
        observedError="Forbidden token=do-not-render"
        retrying={false}
        onClose={() => undefined}
        onRetry={retry}
      />,
    );
    expect(await screen.findByText("Permission denied")).toBeInTheDocument();
    expect(screen.queryByText(/do-not-render/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry connection/i }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("explains missing config onboarding without claiming connectivity", async () => {
    vi.mocked(diagnoseConnection).mockResolvedValue({
      context: null,
      config_path: "C:\\Users\\ravi\\.kube\\config",
      status: "missing_config",
      credential_executable: null,
      credential_executable_available: null,
      message: "No kubeconfig file was found. Create or copy one at the shown path, then rescan.",
      single_source_only: true,
    });
    render(
      <ConnectionDiagnosticsDialog open context={null} retrying={false} onClose={() => undefined} onRetry={() => undefined} />,
    );
    expect(await screen.findByText(/No kubeconfig file was found/i)).toBeInTheDocument();
    expect(screen.queryByText(/first path only/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/connection successful/i)).not.toBeInTheDocument();
  });

  it("hides a previous context result immediately while the next context is inspected", async () => {
    vi.mocked(diagnoseConnection).mockResolvedValueOnce({
      context: "old",
      config_path: "/old/config",
      status: "ready_to_retry",
      credential_executable: "old-login",
      credential_executable_available: true,
      message: "Old context passed inspection.",
      single_source_only: true,
    });
    const next = deferred<Awaited<ReturnType<typeof diagnoseConnection>>>();
    vi.mocked(diagnoseConnection).mockReturnValueOnce(next.promise);
    const view = render(
      <ConnectionDiagnosticsDialog open context="old" retrying={false} onClose={() => undefined} onRetry={() => undefined} />,
    );
    expect(await screen.findByText("/old/config")).toBeInTheDocument();

    view.rerender(
      <ConnectionDiagnosticsDialog open context="new" retrying={false} onClose={() => undefined} onRetry={() => undefined} />,
    );
    expect(screen.queryByText("/old/config")).not.toBeInTheDocument();
    expect(screen.queryByText("old-login")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry connection/i })).toBeDisabled();
    expect(screen.getByText(/Inspecting local configuration/i)).toBeInTheDocument();

    await act(async () => next.reject(new Error("new lookup failed")));
    expect(await screen.findByText(/inspection could not be completed/i)).toBeInTheDocument();
    expect(screen.queryByText("/old/config")).not.toBeInTheDocument();
  });

  it("ignores a deferred response from a context that is no longer selected", async () => {
    const old = deferred<Awaited<ReturnType<typeof diagnoseConnection>>>();
    const current = deferred<Awaited<ReturnType<typeof diagnoseConnection>>>();
    vi.mocked(diagnoseConnection).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = render(
      <ConnectionDiagnosticsDialog open context="old" retrying={false} onClose={() => undefined} onRetry={() => undefined} />,
    );
    view.rerender(
      <ConnectionDiagnosticsDialog open context="current" retrying={false} onClose={() => undefined} onRetry={() => undefined} />,
    );
    await act(async () => old.resolve({
      context: "old",
      config_path: "/stale/config",
      status: "ready_to_retry",
      credential_executable: null,
      credential_executable_available: null,
      message: "Stale result",
      single_source_only: true,
    }));
    expect(screen.queryByText("/stale/config")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry connection/i })).toBeDisabled();
    await act(async () => current.reject(new Error("current lookup failed")));
    await waitFor(() => expect(screen.getByText(/inspection could not be completed/i)).toBeInTheDocument());
    expect(screen.queryByText("Stale result")).not.toBeInTheDocument();
  });

  it("clears a completed result when the same context is reopened and its new inspection fails", async () => {
    vi.mocked(diagnoseConnection).mockResolvedValueOnce({
      context: "same",
      config_path: "/old/same-config",
      status: "ready_to_retry",
      credential_executable: "old-tool",
      credential_executable_available: true,
      message: "Old inspection passed.",
      single_source_only: true,
    });
    const failed = deferred<Awaited<ReturnType<typeof diagnoseConnection>>>();
    vi.mocked(diagnoseConnection).mockReturnValueOnce(failed.promise);
    const view = render(
      <ConnectionDiagnosticsDialog open context="same" retrying={false} onClose={() => undefined} onRetry={() => undefined} />,
    );
    expect(await screen.findByText("/old/same-config")).toBeInTheDocument();
    view.rerender(
      <ConnectionDiagnosticsDialog open={false} context="same" retrying={false} onClose={() => undefined} onRetry={() => undefined} />,
    );
    view.rerender(
      <ConnectionDiagnosticsDialog open context="same" retrying={false} onClose={() => undefined} onRetry={() => undefined} />,
    );
    expect(screen.queryByText("/old/same-config")).not.toBeInTheDocument();
    expect(screen.queryByText("old-tool")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry connection/i })).toBeDisabled();
    await act(async () => failed.reject(new Error("inspection failed")));
    expect(await screen.findByText(/inspection could not be completed/i)).toBeInTheDocument();
    expect(screen.queryByText("Old inspection passed.")).not.toBeInTheDocument();
  });

  it("reinspects after retry so credential-tool remediation replaces the old result", async () => {
    vi.mocked(diagnoseConnection)
      .mockResolvedValueOnce({
        context: "dev",
        config_path: "/tmp/config",
        status: "missing_credential_executable",
        credential_executable: "kubelogin",
        credential_executable_available: false,
        message: "Credential tool is missing.",
        single_source_only: true,
      })
      .mockResolvedValueOnce({
        context: "dev",
        config_path: "/tmp/config",
        status: "ready_to_retry",
        credential_executable: "kubelogin",
        credential_executable_available: true,
        message: "Configuration inspection passed after remediation.",
        single_source_only: true,
      });
    const retry = vi.fn().mockResolvedValue(undefined);
    render(
      <ConnectionDiagnosticsDialog open context="dev" retrying={false} onClose={() => undefined} onRetry={retry} />,
    );
    expect(await screen.findByText("Credential tool is missing.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry connection/i }));
    expect(retry).toHaveBeenCalledOnce();
    expect(await screen.findByText("Configuration inspection passed after remediation.")).toBeInTheDocument();
    expect(screen.queryByText("Credential tool is missing.")).not.toBeInTheDocument();
    expect(diagnoseConnection).toHaveBeenCalledTimes(2);
  });

  it("rescans and reinspects after an externally repaired missing context", async () => {
    vi.mocked(diagnoseConnection)
      .mockResolvedValueOnce({
        context: null,
        config_path: "/tmp/config",
        status: "context_missing",
        credential_executable: null,
        credential_executable_available: null,
        message: "No context is selected and the kubeconfig has no current context.",
        single_source_only: true,
      })
      .mockResolvedValueOnce({
        context: null,
        config_path: "/tmp/config",
        status: "ready_to_retry",
        credential_executable: null,
        credential_executable_available: null,
        message: "Configuration inspection passed after rescan.",
        single_source_only: true,
      });
    const rescan = vi.fn().mockResolvedValue(undefined);
    render(
      <ConnectionDiagnosticsDialog open context={null} retrying={false} onClose={() => undefined} onRetry={rescan} />,
    );
    expect(await screen.findByText(/No context is selected/i)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /retry connection/i });
    expect(retry).toBeEnabled();
    await userEvent.click(retry);
    expect(rescan).toHaveBeenCalledOnce();
    expect(await screen.findByText("Configuration inspection passed after rescan.")).toBeInTheDocument();
    expect(screen.queryByText(/No context is selected/i)).not.toBeInTheDocument();
    expect(diagnoseConnection).toHaveBeenCalledTimes(2);
  });
});
