import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { PreflightPreviewDialog } from "./PreflightPreviewDialog";
import { buildActionPreflight } from "@/lib/preflight";
const impact = buildActionPreflight({ actionType: "restart", targets: [{kind: "deployment", namespace: "apps", name: "api"}, {kind: "deployment", namespace: "apps", name: "web"}] });
it("invalidates a bulk acknowledgement when the selected resources change but the count stays the same", async () => {
  const onCancel = vi.fn();
  const props = {open: true, context: "prod", title: "restart workloads", confirmLabel: "restart", confirmText: "2 restartable", impact, onCancel, onConfirm: vi.fn()};
  const {rerender} = render(<PreflightPreviewDialog {...props} targetDetails={["apps/deployment/api", "apps/deployment/web"]} />);
  await userEvent.type(screen.getByRole("textbox", {name: /confirmation text/i}), "2 restartable");
  expect(screen.getByRole("button", {name: "restart"})).toBeEnabled();
  rerender(<PreflightPreviewDialog {...props} targetDetails={["apps/deployment/api", "apps/deployment/payments"]} />);
  expect(screen.getByRole("button", {name: "restart"})).toBeDisabled();
  expect(onCancel).toHaveBeenCalled();
});
