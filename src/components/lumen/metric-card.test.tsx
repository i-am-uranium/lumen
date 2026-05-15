import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MetricCard } from "./metric-card";

describe("MetricCard", () => {
  it("renders as a non-interactive presentational card when no onClick is provided", () => {
    render(<MetricCard label="Resources" value={16} helper={<span>16 visible</span>} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Resources")).toBeInTheDocument();
    expect(screen.getByText("16")).toBeInTheDocument();
  });

  it("renders as a button and calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(
      <MetricCard
        label="At Risk"
        value={3}
        helper={<span>1 failed — show only</span>}
        onClick={onClick}
        actionLabel="Filter to unhealthy resources"
      />,
    );

    const card = screen.getByRole("button", { name: /filter to unhealthy resources/i });
    fireEvent.click(card);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("activates the click handler on Enter and Space keys", () => {
    const onClick = vi.fn();
    render(
      <MetricCard
        label="Restarts"
        value={9}
        helper={<span>Needs review — show only</span>}
        onClick={onClick}
        actionLabel="Filter to resources with restarts"
      />,
    );

    const card = screen.getByRole("button");
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(card, { key: "a" });

    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("reflects active state via aria-pressed when interactive", () => {
    const { rerender } = render(
      <MetricCard label="At Risk" value={3} onClick={() => {}} active={false} />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");

    rerender(
      <MetricCard label="At Risk" value={3} onClick={() => {}} active={true} />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });
});
