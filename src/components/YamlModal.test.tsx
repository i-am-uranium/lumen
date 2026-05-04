import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { YamlModal } from "./YamlModal";

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

describe("YamlModal", () => {
  it("keeps redacted sensitive YAML read-only", () => {
    renderYamlModal();

    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    expect(
      screen.getByText(/sensitive values are redacted/i),
    ).toBeInTheDocument();
  });
});
