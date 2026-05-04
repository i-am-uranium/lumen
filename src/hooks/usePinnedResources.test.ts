import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePinnedResources, type PinnedRef } from "./usePinnedResources";

const CTX = "test-cluster";
const a: PinnedRef = { kind: "Pod", namespace: "default", name: "alpha" };
const b: PinnedRef = { kind: "Deployment", namespace: "default", name: "beta" };
// Same name as `a` but different namespace — must be treated as distinct.
const aOtherNs: PinnedRef = { kind: "Pod", namespace: "kube-system", name: "alpha" };

describe("usePinnedResources", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("starts empty when nothing is persisted", () => {
    const { result } = renderHook(() => usePinnedResources(CTX));
    expect(result.current.items).toEqual([]);
    expect(result.current.isPinned(a)).toBe(false);
  });

  it("pins a resource and reports it as pinned", () => {
    const { result } = renderHook(() => usePinnedResources(CTX));
    act(() => {
      result.current.pin(a);
    });
    expect(result.current.items).toEqual([a]);
    expect(result.current.isPinned(a)).toBe(true);
    expect(result.current.isPinned(aOtherNs)).toBe(false);
  });

  it("pin is idempotent — pinning twice does not duplicate", () => {
    const { result } = renderHook(() => usePinnedResources(CTX));
    act(() => {
      result.current.pin(a);
      result.current.pin(a);
    });
    expect(result.current.items).toHaveLength(1);
  });

  it("unpins a resource", () => {
    const { result } = renderHook(() => usePinnedResources(CTX));
    act(() => {
      result.current.pin(a);
      result.current.pin(b);
    });
    expect(result.current.items).toHaveLength(2);
    act(() => {
      result.current.unpin(a);
    });
    expect(result.current.items).toEqual([b]);
    expect(result.current.isPinned(a)).toBe(false);
    expect(result.current.isPinned(b)).toBe(true);
  });

  it("toggle adds when absent and removes when present", () => {
    const { result } = renderHook(() => usePinnedResources(CTX));
    act(() => {
      result.current.toggle(a);
    });
    expect(result.current.isPinned(a)).toBe(true);
    act(() => {
      result.current.toggle(a);
    });
    expect(result.current.isPinned(a)).toBe(false);
  });

  it("persists to localStorage and round-trips on a fresh hook instance", () => {
    const { result, unmount } = renderHook(() => usePinnedResources(CTX));
    act(() => {
      result.current.pin(a);
      result.current.pin(b);
    });
    unmount();

    // Storage should contain both items under the ctx key.
    const raw = window.localStorage.getItem(`lumen:pinned:${CTX}`);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(2);

    // A new hook instance reads the persisted items.
    const { result: result2 } = renderHook(() => usePinnedResources(CTX));
    expect(result2.current.items).toHaveLength(2);
    expect(result2.current.isPinned(a)).toBe(true);
    expect(result2.current.isPinned(b)).toBe(true);
  });

  it("scopes pins by cluster context", () => {
    const { result: ctxA } = renderHook(() => usePinnedResources("ctx-a"));
    const { result: ctxB } = renderHook(() => usePinnedResources("ctx-b"));
    act(() => {
      ctxA.current.pin(a);
    });
    expect(ctxA.current.isPinned(a)).toBe(true);
    expect(ctxB.current.isPinned(a)).toBe(false);
  });

  it("treats identical name/kind in different namespaces as distinct", () => {
    const { result } = renderHook(() => usePinnedResources(CTX));
    act(() => {
      result.current.pin(a);
      result.current.pin(aOtherNs);
    });
    expect(result.current.items).toHaveLength(2);
    expect(result.current.isPinned(a)).toBe(true);
    expect(result.current.isPinned(aOtherNs)).toBe(true);
  });
});
