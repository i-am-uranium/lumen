import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { LegacyAssistantRedirect } from "./LegacyAssistantRedirect";

function Destination() {
  const location = useLocation();
  return <output>{location.pathname + location.search}</output>;
}

describe("saved assistant tab recovery", () => {
  it("opens the same cluster and retains saved text without consuming stored context", async () => {
    window.sessionStorage.setItem("old-context", "operator evidence");
    render(
      <MemoryRouter initialEntries={["/cluster/prod%2Fus/ai?namespace=payments&name=api&question=Why%3F&aiContext=old-context"]}>
        <Routes>
          <Route path="/cluster/:ctx/ai" element={<LegacyAssistantRedirect />} />
          <Route path="/cluster/:ctx/workloads" element={<Destination />} />
        </Routes>
      </MemoryRouter>,
    );
    const output = await screen.findByRole("status");
    const url = new URL(output.textContent!, "https://local.invalid");
    expect(url.pathname).toBe("/cluster/prod%2Fus/workloads");
    expect(url.searchParams.get("ns")).toBe("payments");
    expect(url.searchParams.get("q")).toBe("api");
    expect(url.searchParams.get("question")).toBe("Why?");
    expect(url.searchParams.get("aiContext")).toBe("old-context");
    expect(window.sessionStorage.getItem("old-context")).toBe("operator evidence");
    window.sessionStorage.removeItem("old-context");
  });
});
