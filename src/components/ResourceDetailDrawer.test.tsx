import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceDetailDrawer } from "./ResourceDetailDrawer";
import { k8s } from "@/lib/k8s";
import { useUiSettings } from "@/state/uiSettings";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (message: unknown) => void;
  },
  invoke: vi.fn(),
}));

vi.mock("@/components/PinButton", () => ({
  PinButton: () => <button type="button" aria-label="pin resource" />,
}));

vi.mock("@/hooks/useShellDock", () => ({
  useShellDock: () => ({ openSession: vi.fn() }),
}));

vi.mock("./logs/LogsViewer", () => ({
  LogsViewer: ({
    ctx,
    namespace,
    kind,
    name,
  }: {
    ctx: string;
    namespace: string;
    kind: string;
    name: string;
  }) => (
    <div data-testid="logs-viewer">
      {ctx}/{namespace}/{kind}/{name}
    </div>
  ),
}));

vi.mock("@/lib/k8s", () => ({
  k8s: {
    checkAccess: vi.fn(),
    getResource: vi.fn(),
    restartWorkload: vi.fn(),
    scaleWorkload: vi.fn(),
    deleteResource: vi.fn(),
    applyResource: vi.fn(),
    listEventsFor: vi.fn(),
  },
}));

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(k8s.checkAccess).mockResolvedValue({
    allowed: true,
    denied: false,
    reason: null,
    evaluation_error: null,
  });
  vi.mocked(k8s.getResource).mockResolvedValue({
    yaml: "kind: Deployment\nmetadata:\n  name: api\n",
    summary: {
      kind: "deployment",
      name: "api",
      namespace: "default",
      ready: "2/3",
      age_seconds: 300,
      health: "healthy",
      labels: {},
    },
    owner_refs: [],
  });
  vi.mocked(k8s.applyResource).mockResolvedValue({
    yaml: "kind: Deployment\nmetadata:\n  name: api\n",
    dry_run: false,
  });

  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ResourceDetailDrawer
          ctx="dev"
          resource={{ kind: "deployment", namespace: "default", name: "api" }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => useUiSettings.setState({ readOnly: false }));

describe("ResourceDetailDrawer confirmations", () => {
  it("opens inline logs for deployments", async () => {
    renderDrawer();

    await userEvent.click(screen.getByRole("button", { name: /logs \(L\)/i }));

    expect(screen.getByTestId("logs-viewer")).toHaveTextContent(
      "dev/default/deployment/api",
    );
  });

  it("requires typed confirmation before restart, scale, and delete actions", async () => {
    renderDrawer();

    await userEvent.click(screen.getByRole("button", { name: /^restart$/i }));
    let dialog = screen.getByRole("dialog", { name: /restart deployment/i });
    let confirm = within(dialog).getByRole("button", { name: /^restart$/i });
    expect(confirm).toBeDisabled();
    expect(k8s.restartWorkload).not.toHaveBeenCalled();
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /confirmation text/i }),
      "default/api",
    );
    await userEvent.click(confirm);
    expect(k8s.restartWorkload).toHaveBeenCalledWith(
      "default",
      "deployment",
      "api",
      "dev",
    );

    await userEvent.click(screen.getByRole("button", { name: /scale up from 3/i }));
    dialog = screen.getByRole("dialog", { name: /scale deployment/i });
    confirm = within(dialog).getByRole("button", { name: /^scale$/i });
    expect(confirm).toBeDisabled();
    expect(k8s.scaleWorkload).not.toHaveBeenCalled();
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /confirmation text/i }),
      "default/api",
    );
    await userEvent.click(confirm);
    expect(k8s.scaleWorkload).toHaveBeenCalledWith(
      "default",
      "deployment",
      "api",
      4,
      "dev",
    );

    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    dialog = screen.getByRole("dialog", { name: /delete deployment/i });
    confirm = within(dialog).getByRole("button", { name: /^delete$/i });
    expect(confirm).toBeDisabled();
    expect(k8s.deleteResource).not.toHaveBeenCalled();
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /confirmation text/i }),
      "default/api",
    );
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /high risk confirmation/i }),
      "HIGH RISK",
    );
    await userEvent.click(confirm);
    expect(k8s.deleteResource).toHaveBeenCalledWith(
      "default",
      "deployment",
      "api",
      "dev",
    );
  });

  it("requires typed confirmation before applying drawer YAML edits", async () => {
    renderDrawer();

    await userEvent.click(screen.getByRole("button", { name: /yaml \(Y\)/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
    await userEvent.type(screen.getByRole("textbox"), "\nspec:\n  replicas: 4");
    expect(screen.getByRole("button", { name: /^apply$/i })).toBeDisabled();
    expect(k8s.checkAccess).toHaveBeenCalledWith(expect.objectContaining({ verb: "patch", name: "api" }), "dev");
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^apply$/i })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    const dialog = screen.getByRole("dialog", { name: /apply deployment/i });
    const confirm = within(dialog).getByRole("button", { name: /^apply$/i });
    expect(confirm).toBeDisabled();
    expect(vi.mocked(k8s.applyResource).mock.calls.every((call) => call[4] === true)).toBe(true);

    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /confirmation text/i }),
      "default/api",
    );
    await userEvent.click(confirm);

    expect(k8s.applyResource).toHaveBeenCalledWith(
      "default",
      "deployment",
      "api",
      expect.stringContaining("replicas: 4"),
      false,
      "dev",
    );
  });

  it("removes drawer editing and pending confirmations when read-only is enabled", async () => {
    renderDrawer();
    await userEvent.click(screen.getByRole("button", { name: /yaml \(Y\)/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
    await userEvent.type(screen.getByRole("textbox"), "\nspec:\n  replicas: 4");
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^apply$/i })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    expect(screen.getByRole("dialog", { name: /preflight apply deployment/i })).toBeInTheDocument();
    act(() => useUiSettings.getState().setReadOnly(true));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^apply$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /preflight apply deployment/i })).not.toBeInTheDocument();
  });
});
