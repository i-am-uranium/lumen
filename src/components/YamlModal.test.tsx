import { useState } from "react";
import { publishProtection } from "@/hooks/useMutationCapability";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { YamlModal } from "./YamlModal";
import { k8s } from "@/lib/k8s";
import { useUiSettings } from "@/state/uiSettings";

vi.mock("@/lib/k8s", () => ({
  k8s: {
    checkAccess: vi.fn(),
    applyResource: vi.fn(),
  },
}));

function renderYamlModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <YamlModal
        title="secret/db-creds"
        subtitle="default"
        yaml={"kind: Secret\ndata:\n  password: <redacted>\n"}
        sensitive
        editable={{
          namespace: "default",
          kind: "secret",
          name: "db-creds",
          context: "dev",
        }}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

function renderEditableYamlModal({
  yaml = "kind: ConfigMap\nmetadata:\n  name: app\n",
  kind = "configmap",
  name = "app",
  onClose = vi.fn(),
}: {
  yaml?: string;
  kind?: "configmap" | "deployment";
  name?: string;
  onClose?: () => void;
} = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(k8s.checkAccess).mockResolvedValue({
    allowed: true,
    denied: false,
    reason: null,
    evaluation_error: null,
  });
  vi.mocked(k8s.applyResource).mockResolvedValue({
    yaml: "kind: ConfigMap\nmetadata:\n  name: app\n",
    dry_run: false,
  });
  return render(
    <QueryClientProvider client={qc}>
      <YamlModal
        title={`${kind}/${name}`}
        subtitle="default"
        yaml={yaml}
        editable={{
          namespace: "default",
          kind,
          name,
          context: "dev",
        }}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(k8s.applyResource).mockReset();
  useUiSettings.setState({ readOnly: false });
});

describe("YamlModal", () => {
  it("keeps every editable entry point read-only when the global policy is enabled", () => {
    useUiSettings.setState({ readOnly: true });
    renderEditableYamlModal();
    expect(
      screen.queryByRole("button", { name: /^edit$/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("discards pending validation when read-only is enabled and does not restore it on unlock", async () => {
    renderEditableYamlModal();
    let complete!: (out: { yaml: string; dry_run: boolean }) => void;
    vi.mocked(k8s.applyResource).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^edit$/i }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: {
        value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}",
      },
    });
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    act(() => useUiSettings.getState().setReadOnly(true));
    await act(async () =>
      complete({ yaml: "stale validated result", dry_run: true }),
    );
    expect(
      screen.queryByRole("button", { name: /^apply$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("stale validated result"),
    ).not.toBeInTheDocument();
    act(() => useUiSettings.getState().setReadOnly(false));
    await userEvent.click(
      await screen.findByRole("button", { name: /^edit$/i }),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: {
        value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}",
      },
    });
    expect(screen.getByRole("button", { name: /^apply$/i })).toBeDisabled();
    expect(k8s.applyResource).toHaveBeenCalledTimes(1);
  });

  it("checks patch permission for server-side apply instead of update", async () => {
    vi.mocked(k8s.checkAccess).mockImplementation(async (request) => ({
      allowed: request.verb === "patch",
      denied: request.verb !== "patch",
      reason: null,
      evaluation_error: null,
    }));
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <YamlModal
          title="configmap/patchable"
          yaml="kind: ConfigMap"
          editable={{
            namespace: "default",
            kind: "configmap",
            name: "patchable",
            context: "dev",
          }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /edit/i })).toBeEnabled(),
    );
    expect(k8s.checkAccess).toHaveBeenCalledWith(
      expect.objectContaining({ verb: "patch", name: "patchable" }),
      "dev",
    );
  });

  it("blocks apply until this draft passes server validation and invalidates edits", async () => {
    renderEditableYamlModal();
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: {
        value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}",
      },
    });
    const apply = screen.getByRole("button", { name: /^apply$/i });
    expect(apply).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox"), {
      target: {
        value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: two}",
      },
    });
    expect(apply).toBeDisabled();
  });

  it("keeps failed server validation from enabling apply", async () => {
    renderEditableYamlModal();
    vi.mocked(k8s.applyResource).mockRejectedValueOnce(
      new Error("admission denied"),
    );
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: {
        value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}",
      },
    });
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    expect(await screen.findByText("admission denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^apply$/i })).toBeDisabled();
  });

  it("ignores delayed validation after the draft changes", async () => {
    renderEditableYamlModal();
    let complete!: (out: { yaml: string; dry_run: boolean }) => void;
    vi.mocked(k8s.applyResource).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: {
        value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}",
      },
    });
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: {
        value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: two}",
      },
    });
    await act(async () =>
      complete({ yaml: "old server result", dry_run: true }),
    );
    expect(screen.getByRole("button", { name: /^apply$/i })).toBeDisabled();
    expect(screen.queryByText("old server result")).not.toBeInTheDocument();
  });

  it("locks the validated draft while the confirmed write is in flight", async () => {
    renderEditableYamlModal();
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    const input = screen.getByRole("textbox");
    const draft = "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}";
    fireEvent.change(input, { target: { value: draft } });
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    let complete!: (out: { yaml: string; dry_run: boolean }) => void;
    vi.mocked(k8s.applyResource).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    const dialog = screen.getByRole("dialog", { name: /preflight apply/i });
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /confirmation text/i }),
      "default/app",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^apply$/i }),
    );
    expect(input).toBeDisabled();
    expect(k8s.applyResource).toHaveBeenLastCalledWith(
      "default",
      "configmap",
      "app",
      draft,
      false,
      "dev",
    );
    await act(async () => complete({ yaml: draft, dry_run: false }));
  });

  it("does not reuse validation or delayed responses across contexts", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(k8s.checkAccess).mockResolvedValue({
      allowed: true,
      denied: false,
      reason: null,
      evaluation_error: null,
    });
    let complete!: (out: { yaml: string; dry_run: boolean }) => void;
    vi.mocked(k8s.applyResource).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const view = (context: string) => (
      <QueryClientProvider client={qc}>
        <YamlModal
          title="configmap/app"
          subtitle="default"
          yaml="kind: ConfigMap"
          editable={{
            namespace: "default",
            kind: "configmap",
            name: "app",
            context,
          }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    );
    const rendered = render(view("dev"));
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: {
        value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}",
      },
    });
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    rendered.rerender(view("prod"));
    await act(async () =>
      complete({ yaml: "dev server result", dry_run: true }),
    );
    expect(screen.queryByText("dev server result")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^apply$/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps redacted sensitive YAML read-only", () => {
    renderYamlModal();

    expect(
      screen.queryByRole("button", { name: /edit/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/sensitive values are redacted/i),
    ).toBeInTheDocument();
  });

  it("requires typed confirmation before applying YAML changes", async () => {
    renderEditableYamlModal();

    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    await userEvent.type(
      screen.getByRole("textbox"),
      "\n  labels:\n    app: demo",
    );
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    const dialog = screen.getByRole("dialog", { name: /apply configmap/i });
    const confirm = within(dialog).getByRole("button", { name: /^apply$/i });
    expect(confirm).toBeDisabled();
    expect(
      vi.mocked(k8s.applyResource).mock.calls.every((call) => call[4] === true),
    ).toBe(true);

    await userEvent.type(
      screen.getByRole("textbox", { name: /confirmation text/i }),
      "default/app",
    );
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    expect(k8s.applyResource).toHaveBeenCalledWith(
      "default",
      "configmap",
      "app",
      expect.stringContaining("app: demo"),
      false,
      "dev",
    );
    expect(dialog).not.toBeInTheDocument();
  });

  it("shows a preflight preview and requires high-risk confirmation for risky YAML changes", async () => {
    renderEditableYamlModal({
      kind: "deployment",
      name: "api",
      yaml: `kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    spec:
      containers:
      - name: api
        image: ghcr.io/acme/api:v1
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
`,
    });

    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: {
        value: `kind: Deployment
metadata:
  name: api
spec:
  replicas: 5
  selector:
    matchLabels:
      app: api-v2
  template:
    spec:
      containers:
      - name: api
        image: ghcr.io/acme/api:v2
`,
      },
    });
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    const dialog = screen.getByRole("dialog", {
      name: /preflight apply deployment/i,
    });
    expect(
      within(dialog).getAllByText(/selector changed/i).length,
    ).toBeGreaterThan(0);
    expect(
      within(dialog).getAllByText(/readiness\/liveness probe removed/i).length,
    ).toBeGreaterThan(0);

    const confirm = within(dialog).getByRole("button", { name: /^apply$/i });
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /confirmation text/i }),
      "default/api",
    );
    expect(confirm).toBeDisabled();

    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /high risk confirmation/i }),
      "HIGH RISK",
    );
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    expect(k8s.applyResource).toHaveBeenCalledWith(
      "default",
      "deployment",
      "api",
      expect.stringContaining("api-v2"),
      false,
      "dev",
    );
  });
});

vi.mock("@/lib/contextProtection", async (original) => ({
  ...(await original<typeof import("@/lib/contextProtection")>()),
  contextProtection: {
    get: async (context: string) => ({
      context,
      protected: false,
      unlocked_until_ms: null,
      can_mutate: true,
    }),
  },
}));
beforeEach(() => {
  for (const context of ["dev", "prod"])
    publishProtection(context, {
      context,
      protected: false,
      unlocked_until_ms: null,
      can_mutate: true,
    });
});

it("keeps YAML drafting and server dry-run available while the protected context blocks apply", async () => {
  const { contextProtection } = await import("@/lib/contextProtection");
  const locked = {
    context: "dev",
    protected: true,
    unlocked_until_ms: null,
    can_mutate: false,
  };
  const statusSpy = vi
    .spyOn(contextProtection, "get")
    .mockResolvedValue(locked);
  publishProtection("dev", locked);
  renderEditableYamlModal();
  await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: {
      value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}",
    },
  });
  await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
  await waitFor(() =>
    expect(k8s.applyResource).toHaveBeenCalledWith(
      "default",
      "configmap",
      "app",
      expect.any(String),
      true,
      "dev",
    ),
  );
  expect(screen.getByRole("button", { name: /^apply$/i })).toBeDisabled();
  expect(screen.getByRole("textbox")).toBeEnabled();
  statusSpy.mockRestore();
});

it("keeps an intentionally empty draft empty and lets users revert it", async () => {
  renderEditableYamlModal();
  await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  expect(screen.getByRole("textbox")).toHaveValue("");
  await userEvent.click(
    screen.getByRole("button", { name: /^revert draft$/i }),
  );
  expect(screen.getByRole("textbox")).toHaveValue(
    "kind: ConfigMap\nmetadata:\n  name: app\n",
  );
  expect(screen.getByRole("button", { name: /^apply$/i })).toBeDisabled();
});

it("preserves the baseline on refresh and requires explicitly loading the latest YAML", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (yaml: string) => (
    <QueryClientProvider client={qc}>
      <YamlModal
        title="configmap/app"
        yaml={yaml}
        editable={{
          namespace: "default",
          kind: "configmap",
          name: "app",
          context: "dev",
        }}
        onClose={vi.fn()}
      />
    </QueryClientProvider>
  );
  const rendered = render(view("kind: ConfigMap\ndata: old"));
  await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "kind: ConfigMap\ndata: draft" },
  });
  rendered.rerender(view("kind: ConfigMap\ndata: external"));
  expect(screen.getByRole("textbox")).toHaveValue(
    "kind: ConfigMap\ndata: draft",
  );
  expect(screen.getByText(/changed on the server/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^dry-run$/i })).toBeDisabled();
  await userEvent.click(
    screen.getByRole("button", { name: /^revert draft$/i }),
  );
  expect(screen.getByRole("textbox")).toHaveValue("kind: ConfigMap\ndata: old");
  await userEvent.click(screen.getByRole("button", { name: /reload latest/i }));
  expect(screen.getByRole("textbox")).toHaveValue(
    "kind: ConfigMap\ndata: external",
  );
  expect(screen.queryByText(/changed on the server/i)).not.toBeInTheDocument();
});

it("reviews original and draft line changes and invalidates validation on revert", async () => {
  renderEditableYamlModal();
  await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: changed" },
  });
  await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^apply$/i })).toBeEnabled(),
  );
  await userEvent.click(
    screen.getByRole("button", { name: /review changes/i }),
  );
  expect(
    screen.getByRole("region", { name: /yaml changes/i }),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: /^revert draft$/i }),
  );
  expect(screen.getByRole("button", { name: /^apply$/i })).toBeDisabled();
  expect(screen.getByText(/no line changes/i)).toBeInTheDocument();
});

it("uses the acknowledged server YAML as the next baseline before a host refresh", async () => {
  renderEditableYamlModal();
  const draft = "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}";
  const appliedYaml = draft + "\n# server default";
  await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: draft } });
  await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
  vi.mocked(k8s.applyResource).mockResolvedValueOnce({
    yaml: appliedYaml,
    dry_run: false,
  });
  await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
  const dialog = screen.getByRole("dialog", { name: /preflight apply/i });
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: /confirmation text/i }),
    "default/app",
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: /^apply$/i }),
  );
  await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
  expect(screen.getByRole("textbox")).toHaveValue(appliedYaml);
  expect(
    screen.getByRole("button", { name: /^revert draft$/i }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: /^dry-run$/i })).toBeDisabled();
});

it("ignores pending dry-run results after a server refresh even if the source changes back", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (yaml: string) => (
    <QueryClientProvider client={qc}>
      <YamlModal
        title="configmap/app"
        yaml={yaml}
        editable={{
          namespace: "default",
          kind: "configmap",
          name: "app",
          context: "dev",
        }}
        onClose={vi.fn()}
      />
    </QueryClientProvider>
  );
  const original = "kind: ConfigMap\ndata: old";
  const rendered = render(view(original));
  let complete!: (out: { yaml: string; dry_run: boolean }) => void;
  vi.mocked(k8s.applyResource).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "kind: ConfigMap\ndata: draft" },
  });
  await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
  rendered.rerender(view("kind: ConfigMap\ndata: external"));
  rendered.rerender(view(original));
  await act(async () =>
    complete({ yaml: "outdated validation", dry_run: true }),
  );
  expect(screen.queryByText("outdated validation")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^apply$/i })).toBeDisabled();
});

it("contains keyboard focus and returns it to the opener after Escape", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <QueryClientProvider client={qc}>
        <button onClick={() => setOpen(true)}>Open YAML</button>
        <button>Outside</button>
        {open && (
          <YamlModal
            title="configmap/keyboard"
            yaml="kind: ConfigMap"
            onClose={() => setOpen(false)}
          />
        )}
      </QueryClientProvider>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open YAML" });
  await userEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "configmap/keyboard" });
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  const close = within(dialog).getByRole("button", { name: "Close YAML" });
  close.focus();
  await userEvent.tab();
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  await userEvent.tab({ shift: true });
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(() => expect(opener).toHaveFocus());
});

it("does not create a second dialog or capture Escape when embedded", async () => {
  const onClose = vi.fn();
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <YamlModal
        title="configmap/embedded"
        yaml="kind: ConfigMap"
        embedded
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Close YAML" }),
  ).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
});

it("Escape dismisses preflight without closing the editor", async () => {
  renderEditableYamlModal();
  await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
  const editor = screen.getByRole("textbox", { name: "YAML draft" });
  fireEvent.change(editor, {
    target: { value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: changed" },
  });
  await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
  await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
  expect(
    screen.getByRole("dialog", { name: /preflight apply/i }),
  ).toBeInTheDocument();
  const chrome = editor.closest("[inert]")!;
  expect(getComputedStyle(chrome).visibility).toBe("hidden");
  const preflight = screen.getByRole("dialog", { name: /preflight apply/i });
  await userEvent.type(
    within(preflight).getByRole("textbox", { name: /confirmation text/i }),
    "default/app",
  );
  const last = within(preflight).getByRole("button", { name: /^apply$/i });
  last.focus();
  await userEvent.tab();
  expect(
    within(preflight).getAllByRole("button", { name: /^cancel$/i })[0],
  ).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(last).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(getComputedStyle(chrome).visibility).toBe("visible");
  expect(
    screen.queryByRole("dialog", { name: /preflight apply/i }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("dialog", { name: "configmap/app" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "YAML draft" })).toHaveValue(
    "kind: ConfigMap\nmetadata:\n  name: app\ndata: changed",
  );
});

it("keeps the editor open while an acknowledged write is pending", async () => {
  const onClose = vi.fn();
  renderEditableYamlModal({ onClose });
  await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
  const draft = "kind: ConfigMap\nmetadata:\n  name: app\ndata: changed";
  fireEvent.change(screen.getByRole("textbox"), { target: { value: draft } });
  await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
  let complete!: (out: { yaml: string; dry_run: boolean }) => void;
  vi.mocked(k8s.applyResource).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
  const preflight = screen.getByRole("dialog", { name: /preflight apply/i });
  await userEvent.type(
    within(preflight).getByRole("textbox", { name: /confirmation text/i }),
    "default/app",
  );
  await userEvent.click(
    within(preflight).getByRole("button", { name: /^apply$/i }),
  );
  expect(screen.getByRole("button", { name: "Close YAML" })).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  expect(
    screen.getByRole("dialog", { name: "configmap/app" }),
  ).toBeInTheDocument();
  await act(async () => complete({ yaml: draft, dry_run: false }));
  expect(screen.getByRole("button", { name: "Close YAML" })).toBeEnabled();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
});
