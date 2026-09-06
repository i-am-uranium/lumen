import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, act } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { k8s } from "@/lib/k8s";
import { LogsTab } from "./LogsTab";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage?: (message: unknown) => void;
  },
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/k8s", () => ({
  k8s: {
    listNamespaces: vi.fn(),
    listWorkloads: vi.fn(),
    listPodContainers: vi.fn(),
  },
}));

function renderLogs(initialEntry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Link to="/cluster/stage/logs?ns=other&kind=pod&name=api&c=sidecar">switch investigation</Link>
        <Routes>
          <Route path="/cluster/:ctx/logs" element={<LogsTab />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("LogsTab deep links", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(k8s.listPodContainers).mockResolvedValue([]);
    vi.mocked(k8s.listNamespaces).mockResolvedValue(["prod", "checkout"]);
  });

  it("preserves the linked failing container and requests only previous logs", async () => {
    vi.mocked(k8s.listWorkloads).mockResolvedValue([]);
    renderLogs("/cluster/prod/logs?ns=payments&kind=pod&name=api&c=worker&previous=true&startedAt=2026-09-06T00%3A00%3A00Z");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stream_logs", expect.objectContaining({ selector: expect.objectContaining({ namespace: "payments", pod_name: "api", container: "worker", previous: true }), context: "prod" })));
    const requests = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "stream_logs");
    expect(requests.every(([, args]) => (args as { selector: { container: string } }).selector.container === "worker")).toBe(true);
    expect(screen.getByText(/previous container logs/i)).toBeInTheDocument();
  });

  it("switches URL context and container without accepting old channel events", async () => {
    vi.mocked(k8s.listWorkloads).mockResolvedValue([]);
    renderLogs("/cluster/prod/logs?ns=payments&kind=pod&name=api&c=worker&previous=true");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stream_logs", expect.objectContaining({ context: "prod" })));
    const old = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "stream_logs")![1] as { streamId: string; channel: { onmessage: (value: unknown) => void } };
    await userEvent.click(screen.getByRole("link", { name: "switch investigation" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stream_logs", expect.objectContaining({ context: "stage", selector: expect.objectContaining({ namespace: "other", pod_name: "api", container: "sidecar", previous: false }) })));
    expect(invoke).toHaveBeenCalledWith("stop_stream", { streamId: old.streamId });
    act(() => old.channel.onmessage({ type: "status", pod: "api", status: "error", message: "stale production failure" }));
    expect(screen.queryByText("stale production failure")).not.toBeInTheDocument();
    expect(screen.queryByText(/previous container logs/i)).not.toBeInTheDocument();
  });

  it("resolves a workload name across namespaces when a deep link omits namespace", async () => {
    vi.mocked(k8s.listWorkloads).mockResolvedValue([
      {
        kind: "deployment",
        name: "customer-service",
        namespace: "prod",
        ready: "2/2",
        age_seconds: 120,
        health: "healthy",
        labels: {},
      },
    ]);

    renderLogs(
      "/cluster/ms-aks-stage/logs?kind=deployment&name=customer-service&grep=customer+service",
    );

    await waitFor(() => {
      expect(k8s.listWorkloads).toHaveBeenCalledWith(
        "",
        "deployment",
        "ms-aks-stage",
      );
    });
    await screen.findByText("prod");
    const matches = await screen.findAllByText("customer-service");
    expect(matches.length).toBeGreaterThan(0);
  });
  it("keeps a failed pod visible when another pod becomes live", async () => {
    vi.mocked(k8s.listWorkloads).mockResolvedValue([]);
    renderLogs("/cluster/dev/logs?kind=deployment&name=api&ns=prod");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stream_logs", expect.anything()));
    const args = vi.mocked(invoke).mock.calls.find(([command]) => command === "stream_logs")![1] as {
      channel: { onmessage: (event: unknown) => void };
    };
    act(() => {
      args.channel.onmessage({ type: "status", pod: "api-1", status: "error", message: "access denied for api-1" });
      args.channel.onmessage({ type: "status", pod: "api-2", status: "live" });
    });
    expect(screen.getByText("access denied for api-1")).toBeInTheDocument();
  });

});
