import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { Settings } from "./Settings";

describe("Settings", () => {
  it("shows the running app version", () => {
    render(<Settings />);

    expect(screen.getByText("Version")).toBeInTheDocument();
    expect(screen.getByText(`v${packageJson.version}`)).toBeInTheDocument();
  });
});
