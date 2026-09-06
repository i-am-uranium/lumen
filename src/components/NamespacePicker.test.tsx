import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NamespacePicker } from "./NamespacePicker";

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = vi.fn();

describe("NamespacePicker", () => {
  it("keeps the selected namespace available when discovery omits it", () => {
    render(<NamespacePicker value="payments" namespaces={["default"]} onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /payments/i }));

    expect(screen.getByRole("option", { name: /payments/i })).toBeInTheDocument();
  });

  it("allows explicitly selecting a valid namespace absent from discovery", () => {
    const onChange = vi.fn();
    render(<NamespacePicker value="" namespaces={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /all namespaces/i }));
    fireEvent.change(screen.getByPlaceholderText(/filter or enter namespace/i), {
      target: { value: "payments" },
    });

    fireEvent.click(screen.getByRole("button", { name: "use namespace payments" }));

    expect(onChange).toHaveBeenCalledWith("payments");
  });

  it("rejects malformed Kubernetes namespace names", () => {
    const onChange = vi.fn();
    render(<NamespacePicker value="" namespaces={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /all namespaces/i }));
    fireEvent.change(screen.getByPlaceholderText(/filter or enter namespace/i), {
      target: { value: "Payments_Invalid" },
    });

    expect(screen.queryByRole("button", { name: /use namespace/i })).not.toBeInTheDocument();
    expect(screen.getByText(/valid kubernetes namespace/i)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
