import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
  },
}));

function renderLogs(initialEntry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
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
    vi.mocked(k8s.listNamespaces).mockResolvedValue(["prod", "checkout"]);
  });

  it("resolves a workload name across namespaces when Copilot omits namespace", async () => {
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
    expect(screen.getByText("customer-service")).toBeInTheDocument();
  });
});
