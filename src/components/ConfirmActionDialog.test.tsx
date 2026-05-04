import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

describe("ConfirmActionDialog", () => {
  it("requires the exact target before confirming", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmActionDialog
        open
        title="delete pod"
        description="This deletes the pod immediately."
        target="prod/payment-api-123"
        confirmLabel="delete"
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByRole("button", { name: /^delete$/i });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox", { name: /confirmation text/i }), "payment-api-123");
    expect(confirm).toBeDisabled();

    await userEvent.clear(screen.getByRole("textbox", { name: /confirmation text/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /confirmation text/i }), "prod/payment-api-123");
    expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
