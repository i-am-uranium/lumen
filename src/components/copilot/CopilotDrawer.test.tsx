import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_SESSIONS_STORAGE_KEY } from "@/lib/aiSessions";
import { ai } from "@/lib/ai";
import { k8s, type WorkloadKind, type WorkloadSummary } from "@/lib/k8s";
import { useCopilotUi } from "@/state/copilotUi";
import { CopilotDrawer } from "./CopilotDrawer";

vi.mock("@/lib/ai", () => ({
  ai: {
    detectProviders: vi.fn(async () => [
      {
        id: "codex",
        label: "Codex",
        command: "codex",
        available: false,
        path: null,
        command_preview: "codex exec",
        models: ["gpt-5.2"],
        default_model: "gpt-5.2",
      },
      {
        id: "claude",
        label: "Claude Code",
        command: "claude",
        available: false,
        path: null,
        command_preview: "claude -p",
        models: ["sonnet"],
        default_model: "sonnet",
      },
    ]),
    runPrompt: vi.fn(),
  },
}));

vi.mock("@/lib/k8s", async () => {
  const actual = await vi.importActual<typeof import("@/lib/k8s")>("@/lib/k8s");
  return {
    ...actual,
    k8s: {
      listWorkloads: vi.fn(),
      listPodsFor: vi.fn(),
      listEventsFor: vi.fn(),
    },
  };
});

beforeEach(() => {
  vi.resetAllMocks();
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  HTMLElement.prototype.scrollTo = vi.fn();
  window.localStorage.clear();
  useCopilotUi.getState().reset();
  vi.mocked(k8s.listWorkloads).mockImplementation(async (_namespace, kind) =>
    [workload("customer-service", "checkout")].filter((item) => item.kind === kind),
  );
  vi.mocked(k8s.listPodsFor).mockResolvedValue([
    workload("customer-service-7f9d", "checkout", "pod", {
      health: "degraded",
      ready: "0/1",
      restart_count: 4,
    }),
  ]);
  vi.mocked(k8s.listEventsFor).mockResolvedValue([
    {
      ts: "2026-05-10T00:00:00Z",
      type_: "Warning",
      reason: "BackOff",
      message: "BackOff on customer-service",
      involved_kind: "Pod",
      involved_name: "customer-service-7f9d",
      count: 1,
    },
  ]);
});

function workload(
  name: string,
  namespace = "checkout",
  kind: WorkloadKind = "deployment",
  overrides: Partial<WorkloadSummary> = {},
): WorkloadSummary {
  return {
    kind,
    name,
    namespace,
    ready: "2/2",
    age_seconds: 120,
    health: "healthy",
    labels: {},
    ...overrides,
  };
}

function renderDrawer(route = "/cluster/ms-aks-stage/logs?ns=checkout") {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  useCopilotUi.getState().openDrawer();
  return render(
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider client={qc}>
        <CopilotDrawer clusterContext="ms-aks-stage" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("CopilotDrawer", () => {
  it("persists a latest logs investigation and renders a navigation CTA", async () => {
    renderDrawer();

    const composer = screen.getByRole("textbox", { name: /ask copilot/i });
    await userEvent.type(
      composer,
      "show latest logs from customer service",
    );
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(composer).toHaveValue("");
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("show latest logs from customer service")).toBeInTheDocument();
    expect(await screen.findByText("Copilot")).toBeInTheDocument();
    const cta = await screen.findByRole("link", { name: /open logs/i });
    expect(cta).toHaveAttribute(
      "href",
      "/cluster/ms-aks-stage/logs?ns=checkout&kind=deployment&name=customer-service&grep=customer-service",
    );

    const sessions = JSON.parse(window.localStorage.getItem(AI_SESSIONS_STORAGE_KEY) ?? "[]");
    expect(sessions[0]).toMatchObject({
      title: "Found deployment/customer-service",
      provider: "lumen-copilot",
      model: "read-only-router",
    });
    expect(useCopilotUi.getState().activeSessionId).toBe(sessions[0].id);
  });

  it("renders resolved target and evidence cards", async () => {
    renderDrawer();

    await userEvent.type(
      screen.getByRole("textbox", { name: /ask copilot/i }),
      "why is customer service failing",
    );
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText(/Found deployment\/customer-service/)).toBeInTheDocument();
    expect(screen.getAllByText("deployment/checkout/customer-service").length).toBeGreaterThan(0);
    expect(screen.getByText("BackOff")).toBeInTheDocument();
    expect(screen.getByText("customer-service-7f9d: 4")).toBeInTheDocument();
  });

  it("renders ambiguous resource candidates instead of guessing", async () => {
    vi.mocked(k8s.listWorkloads).mockImplementation(async (_namespace, kind) =>
      [
        workload("customer-service", "checkout"),
        workload("customer-service", "payments"),
      ].filter((item) => item.kind === kind),
    );

    renderDrawer("/cluster/ms-aks-stage/logs");

    await userEvent.type(
      screen.getByRole("textbox", { name: /ask copilot/i }),
      "fetch customer service logs",
    );
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText(/Choose a matching resource/)).toBeInTheDocument();
    expect(screen.getByText("deployment/checkout/customer-service (100)")).toBeInTheDocument();
    expect(screen.getByText("deployment/payments/customer-service (100)")).toBeInTheDocument();
  });

  it("keeps the session when closed and clears it only for a new investigation", async () => {
    renderDrawer();

    await userEvent.type(screen.getByRole("textbox", { name: /ask copilot/i }), "incident update");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    const sessionId = useCopilotUi.getState().activeSessionId;

    await userEvent.click(screen.getByRole("button", { name: /close copilot/i }));
    expect(useCopilotUi.getState().isOpen).toBe(false);
    expect(useCopilotUi.getState().activeSessionId).toBe(sessionId);

    act(() => {
      useCopilotUi.getState().openDrawer();
    });
    await userEvent.click(screen.getByRole("button", { name: /new investigation/i }));
    expect(useCopilotUi.getState()).toMatchObject({
      isOpen: true,
      activeSessionId: null,
      draft: "",
    });
  });

  it("routes sync intent to ArgoCD instead of running a mutation", async () => {
    renderDrawer("/cluster/ms-aks-stage/argocd");

    await userEvent.type(
      screen.getByRole("textbox", { name: /ask copilot/i }),
      "I deployed the doctor dashboard, please sync",
    );
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    const drawer = screen.getByRole("complementary", { name: /operator copilot/i });
    expect(within(drawer).getByText(/I will not run sync from here/i)).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /open argocd app/i })).toHaveAttribute(
      "href",
      "/cluster/ms-aks-stage/argocd?app=argocd%2Fdoctor-dashboard",
    );
  });

  it("shows compact provider, model, and instruction settings in the drawer", async () => {
    renderDrawer();

    await userEvent.click(screen.getByRole("button", { name: /copilot settings/i }));

    expect(screen.getByLabelText(/use model to understand requests/i)).toBeChecked();
    expect(screen.getByRole("combobox", { name: /^provider$/i })).toHaveValue("codex");
    expect(screen.getByRole("combobox", { name: /^model$/i })).toHaveValue("gpt-5.2");
    expect(screen.getByLabelText(/instructions/i)).toHaveValue(
      "You are a Kubernetes operator assistant inside Lumen. Understand the user's intent, preserve exact workload names, prefer read-only navigation, and never invent destructive actions.",
    );
  });

  it("uses the configured model to understand the request when the provider is available", async () => {
    vi.mocked(ai.detectProviders).mockResolvedValue([
      {
        id: "codex",
        label: "Codex",
        command: "codex",
        available: true,
        path: "/opt/homebrew/bin/codex",
        command_preview: "codex exec",
        models: ["gpt-5.2"],
        default_model: "gpt-5.2",
      },
      {
        id: "claude",
        label: "Claude Code",
        command: "claude",
        available: false,
        path: null,
        command_preview: "claude -p",
        models: ["sonnet"],
        default_model: "sonnet",
      },
    ]);
    vi.mocked(ai.runPrompt).mockResolvedValue({
      provider: "codex",
      stdout: JSON.stringify({
        kind: "logs",
        targetText: "customer service",
        requestedAction: "open",
      }),
      stderr: "",
      exit_code: 0,
      timed_out: false,
    });

    renderDrawer();
    await waitFor(() => expect(ai.detectProviders).toHaveBeenCalled());

    await userEvent.type(
      screen.getByRole("textbox", { name: /ask copilot/i }),
      "can you pull what I need for checkout customer traffic",
    );
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await screen.findByRole("link", { name: /open logs/i });
    expect(ai.runPrompt).toHaveBeenCalledWith(
      "codex",
      expect.stringContaining("can you pull what I need for checkout customer traffic"),
      "gpt-5.2",
    );
  });
});
