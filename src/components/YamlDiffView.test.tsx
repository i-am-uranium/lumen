import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YamlDiffView } from "./YamlDiffView";

describe("YamlDiffView", () => {
  it("labels sides, line numbers, and change types without relying on color", () => {
    render(<YamlDiffView before="replicas: 1" after="replicas: 2" />);
    expect(
      screen.getByRole("region", { name: "YAML changes" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Original line 1, removed:")).toBeInTheDocument();
    expect(screen.getByText("Draft line 1, added:")).toBeInTheDocument();
    expect(screen.getByText("1 added · 1 removed")).toBeInTheDocument();
    expect(screen.getByText("replicas: 1")).toBeInTheDocument();
    expect(screen.getByText("replicas: 2")).toBeInTheDocument();
  });
  it("states explicitly when a complete diff cannot be displayed", () => {
    render(<YamlDiffView before={"x\n".repeat(2000)} after="y" />);
    expect(screen.getByText(/Line comparison unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/added ·/)).not.toBeInTheDocument();
  });
  it("renders YAML as text even when it contains markup", () => {
    const { container } = render(
      <YamlDiffView before="" after={'value: <script>alert("x")</script>'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(
      screen.getByText('value: <script>alert("x")</script>'),
    ).toBeInTheDocument();
  });
});
