import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
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

function renderEditableYamlModal() {
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
        title="configmap/app"
        subtitle="default"
        yaml={"kind: ConfigMap\nmetadata:\n  name: app\n"}
        editable={{
          namespace: "default",
          kind: "configmap",
          name: "app",
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
});
