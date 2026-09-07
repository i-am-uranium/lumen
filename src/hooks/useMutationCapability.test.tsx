import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PaneProvider } from "@/components/PaneContext";
import { publishProtection, useMutationCapability } from "./useMutationCapability";
import { usePanesStore } from "@/state/panes";
import { useUiSettings } from "@/state/uiSettings";
vi.mock("@/lib/contextProtection", async (original) => ({ ...await original<any>(), contextProtection: { get: async (context: string) => ({ context, protected: context === "prod", unlocked_until_ms: null, can_mutate: context !== "prod" }) } }));
function Capability({ label }: {label: string}) { const capability = useMutationCapability(); return <button aria-label={label} disabled={!capability.canMutate}>{capability.context}</button>; }
beforeEach(() => {
  useUiSettings.setState({ readOnly: false });
  usePanesStore.setState({ panes: [{id: "left", url: "/cluster/prod/workloads"}, {id: "right", url: "/cluster/dev/workloads"}], focusedId: "left" });
  for (const context of ["prod", "dev"]) publishProtection(context, { context, protected: context === "prod", unlocked_until_ms: null, can_mutate: context !== "prod" });
});
it("uses each owning pane regardless of focus and applies global read-only to both", async () => {
  render(<><PaneProvider paneId="left"><Capability label="left mutation" /></PaneProvider><PaneProvider paneId="right"><Capability label="right mutation" /></PaneProvider></>);
  await act(async () => {});
  expect(screen.getByRole("button", { name: "left mutation" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "right mutation" })).toBeEnabled();
  act(() => usePanesStore.setState({ focusedId: "right" }));
  expect(screen.getByRole("button", { name: "left mutation" })).toHaveTextContent("prod");
  expect(screen.getByRole("button", { name: "left mutation" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "right mutation" })).toBeEnabled();
  act(() => useUiSettings.setState({ readOnly: true }));
  expect(screen.getByRole("button", { name: "right mutation" })).toBeDisabled();
});
