import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { k8s } from "@/lib/k8s";
import { useUiSettings } from "@/state/uiSettings";
import { useNamespaceScope } from "./useNamespaceScope";

vi.mock("@/lib/k8s", async () => {
  const actual = await vi.importActual<typeof import("@/lib/k8s")>("@/lib/k8s");
  return {
    ...actual,
    k8s: {
      ...actual.k8s,
      listContexts: vi.fn(),
      listNamespaces: vi.fn(),
    },
  };
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiSettings.setState({ selectedNamespaces: {} });
  vi.mocked(k8s.listContexts).mockResolvedValue([
    { name: "dev", cluster: "dev", user: "me", namespace: "payments", is_current: true, is_prod: false },
    { name: "prod", cluster: "prod", user: "me", namespace: "platform", is_current: false, is_prod: true },
  ]);
  vi.mocked(k8s.listNamespaces).mockResolvedValue(["default", "payments"]);
});

describe("useNamespaceScope", () => {
  it("lets an explicit URL namespace win over persisted scope", async () => {
    useUiSettings.setState({ selectedNamespaces: { dev: "saved" } });

    const { result } = renderHook(() => useNamespaceScope("dev", "payments"), { wrapper });

    expect(result.current.namespace).toBe("payments");
    expect(result.current.isLoading).toBe(false);
  });

  it("honors an explicitly persisted empty scope without waiting for contexts", () => {
    useUiSettings.setState({ selectedNamespaces: { dev: "" } });
    vi.mocked(k8s.listContexts).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useNamespaceScope("dev"), { wrapper });

    expect(result.current.namespace).toBe("");
    expect(result.current.isLoading).toBe(false);
  });

  it("keeps an explicit empty URL scope as all namespaces", () => {
    useUiSettings.setState({ selectedNamespaces: { dev: "saved" } });

    const { result } = renderHook(() => useNamespaceScope("dev", ""), { wrapper });

    expect(result.current.namespace).toBe("");
    expect(result.current.isLoading).toBe(false);
  });

  it("uses each context's own namespace instead of borrowing the prior context", async () => {
    const { result, rerender } = renderHook(
      ({ context }) => useNamespaceScope(context),
      { initialProps: { context: "dev" }, wrapper },
    );
    await waitFor(() => expect(result.current.namespace).toBe("payments"));

    rerender({ context: "prod" });

    await waitFor(() => expect(result.current.namespace).toBe("platform"));
  });

  it("keeps explicit selection available when namespace discovery is forbidden", async () => {
    const denied = new Error("namespaces is forbidden");
    vi.mocked(k8s.listNamespaces).mockRejectedValue(denied);
    const { result } = renderHook(() => useNamespaceScope("dev", "payments"), { wrapper });

    await waitFor(() => expect(result.current.discoveryError).toBe(denied));
    expect(result.current.namespace).toBe("payments");

    act(() => result.current.setNamespace("orders"));
    expect(useUiSettings.getState().selectedNamespaces.dev).toBe("orders");
  });

  it("preserves a manually selected namespace in the discovered choices", async () => {
    const { result } = renderHook(() => useNamespaceScope("dev", "custom"), { wrapper });

    await waitFor(() => expect(result.current.namespaces).toContain("default"));
    expect(result.current.namespaces).toContain("custom");
  });
});
