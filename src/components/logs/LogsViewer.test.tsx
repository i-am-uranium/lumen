import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LogsViewer } from "./LogsViewer";
import { k8s } from "@/lib/k8s";

vi.mock("./LogsPanel", () => ({
  LogsPanel: ({ pod }: { pod: string }) => (
    <div data-testid="logs-panel">{pod}</div>
  ),
}));

vi.mock("@/lib/k8s", () => ({
  k8s: {
    listPodsFor: vi.fn(),
    getPodDetails: vi.fn(),
  },
}));

function renderViewer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LogsViewer
        ctx="dev"
        namespace="prod"
        kind="deployment"
        name="customer-service"
      />
    </QueryClientProvider>,
  );
}

describe("LogsViewer", () => {
  it("replaces a deployment placeholder with the first child pod", async () => {
    vi.mocked(k8s.listPodsFor).mockResolvedValue([
      {
        kind: "pod",
        name: "customer-service-7f9d",
        namespace: "prod",
        ready: "1/1",
        age_seconds: 60,
        health: "healthy",
        labels: {},
      },
    ]);
    vi.mocked(k8s.getPodDetails).mockResolvedValue({
      name: "customer-service-7f9d",
      namespace: "prod",
      status: "Running",
      qos_class: "Burstable",
      node_name: null,
      controlled_by: null,
      service_account: null,
      pod_ip: null,
      pod_ips: [],
      conditions: [],
      tolerations: 0,
      labels: {},
      annotations: {},
      containers: [],
      cpu_usage_milli: null,
      mem_usage_bytes: null,
      age_seconds: 60,
      created_at_ms: 0,
    });

    renderViewer();

    await waitFor(() =>
      expect(screen.getByTestId("logs-panel")).toHaveTextContent(
        "customer-service-7f9d",
      ),
    );
    expect(screen.queryByText("customer-service")).not.toBeInTheDocument();
  });
});
