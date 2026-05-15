import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyableName } from "./copyable-name";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function mockClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("CopyableName", () => {
  it("writes the value to clipboard on click and toggles the check icon", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const { toast } = await import("sonner");

    render(
      <CopyableName value="my-pod-abc">
        <span>my-pod-abc</span>
      </CopyableName>,
    );

    const button = screen.getByRole("button", { name: /copy my-pod-abc/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("my-pod-abc");
    });
    expect(toast.success).toHaveBeenCalledWith('copied "my-pod-abc"');
    await waitFor(() => {
      expect(button).toHaveAttribute("title", "copied");
    });
  });

  it("surfaces an error toast when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    mockClipboard(writeText);
    const { toast } = await import("sonner");

    render(
      <CopyableName value="x">
        <span>x</span>
      </CopyableName>,
    );

    fireEvent.click(screen.getByRole("button", { name: /copy x/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("copy failed");
    });
  });
});
