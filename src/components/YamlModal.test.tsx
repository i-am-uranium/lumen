import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

describe("YamlModal", () => {
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
    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    const dialog = screen.getByRole("dialog", { name: /apply configmap/i });
    const confirm = within(dialog).getByRole("button", { name: /^apply$/i });
    expect(confirm).toBeDisabled();
    expect(k8s.applyResource).not.toHaveBeenCalled();

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
