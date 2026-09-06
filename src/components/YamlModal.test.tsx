import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { YamlModal } from "./YamlModal";
import { k8s } from "@/lib/k8s";

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
}: {
  yaml?: string;
  kind?: "configmap" | "deployment";
  name?: string;
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
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => { vi.mocked(k8s.applyResource).mockReset(); });

describe("YamlModal", () => {
  it("checks patch permission for server-side apply instead of update", async () => {
    vi.mocked(k8s.checkAccess).mockImplementation(async (request) => ({
      allowed: request.verb === "patch", denied: request.verb !== "patch", reason: null, evaluation_error: null,
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><YamlModal title="configmap/patchable" yaml="kind: ConfigMap" editable={{ namespace: "default", kind: "configmap", name: "patchable", context: "dev" }} onClose={vi.fn()} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: /edit/i })).toBeEnabled());
    expect(k8s.checkAccess).toHaveBeenCalledWith(expect.objectContaining({ verb: "patch", name: "patchable" }), "dev");
  });

  it("blocks apply until this draft passes server validation and invalidates edits", async () => {
    renderEditableYamlModal();
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}" } });
    const apply = screen.getByRole("button", { name: /^apply$/i });
    expect(apply).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: two}" } });
    expect(apply).toBeDisabled();
  });

  it("keeps failed server validation from enabling apply", async () => {
    renderEditableYamlModal();
    vi.mocked(k8s.applyResource).mockRejectedValueOnce(new Error("admission denied"));
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}" } });
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    expect(await screen.findByText("admission denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^apply$/i })).toBeDisabled();
  });

  it("ignores delayed validation after the draft changes", async () => {
    renderEditableYamlModal();
    let complete!: (out: { yaml: string; dry_run: boolean }) => void;
    vi.mocked(k8s.applyResource).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}" } });
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: two}" } });
    await act(async () => complete({ yaml: "old server result", dry_run: true }));
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
    vi.mocked(k8s.applyResource).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /confirmation text/i }), "default/app");
    await userEvent.click(within(dialog).getByRole("button", { name: /^apply$/i }));
    expect(input).toBeDisabled();
    expect(k8s.applyResource).toHaveBeenLastCalledWith("default", "configmap", "app", draft, false, "dev");
    await act(async () => complete({ yaml: draft, dry_run: false }));
  });

  it("does not reuse validation or delayed responses across contexts", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(k8s.checkAccess).mockResolvedValue({ allowed: true, denied: false, reason: null, evaluation_error: null });
    let complete!: (out: { yaml: string; dry_run: boolean }) => void;
    vi.mocked(k8s.applyResource).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const view = (context: string) => <QueryClientProvider client={qc}><YamlModal title="configmap/app" subtitle="default" yaml="kind: ConfigMap" editable={{ namespace: "default", kind: "configmap", name: "app", context }} onClose={vi.fn()} /></QueryClientProvider>;
    const rendered = render(view("dev"));
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "kind: ConfigMap\nmetadata:\n  name: app\ndata: {x: one}" } });
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    rendered.rerender(view("prod"));
    await act(async () => complete({ yaml: "dev server result", dry_run: true }));
    expect(screen.queryByText("dev server result")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^apply$/i })).not.toBeInTheDocument();
  });

  it("keeps redacted sensitive YAML read-only", () => {
    renderYamlModal();

    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/sensitive values are redacted/i),
    ).toBeInTheDocument();
  });

  it("requires typed confirmation before applying YAML changes", async () => {
    renderEditableYamlModal();

    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    await userEvent.type(screen.getByRole("textbox"), "\n  labels:\n    app: demo");
    await userEvent.click(screen.getByRole("button", { name: /^dry-run$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    const dialog = screen.getByRole("dialog", { name: /apply configmap/i });
    const confirm = within(dialog).getByRole("button", { name: /^apply$/i });
    expect(confirm).toBeDisabled();
    expect(vi.mocked(k8s.applyResource).mock.calls.every((call) => call[4] === true)).toBe(true);

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

    const dialog = screen.getByRole("dialog", { name: /preflight apply deployment/i });
    expect(within(dialog).getAllByText(/selector changed/i).length).toBeGreaterThan(0);
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
