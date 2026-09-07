import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { useState } from "react";
import { useUi } from "@/state/ui";
import { CommandPaletteHost } from "./CommandPaletteHost";

const moduleLoaded = vi.hoisted(() => vi.fn());
vi.mock("./CommandPalette", () => {
  moduleLoaded();
  return {
    CommandPalette: () => {
      const open = useUi((state) => state.paletteOpen);
      const [query, setQuery] = useState("");
      return open ? <input aria-label="Palette query" value={query} onChange={(event) => setQuery(event.target.value)} /> : null;
    },
  };
});

it("loads on the first shortcut, toggles once, and preserves state on reopen", async () => {
  useUi.setState({ paletteOpen: false });
  const user = userEvent.setup();
  render(<CommandPaletteHost />);
  expect(moduleLoaded).not.toHaveBeenCalled();
  await user.keyboard("{Control>}k{/Control}");
  const query = await screen.findByRole("textbox", { name: "Palette query" });
  expect(moduleLoaded).toHaveBeenCalledTimes(1);
  await user.type(query, "payments");
  await user.keyboard("{Control>}k{/Control}");
  await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  await user.keyboard("{Control>}k{/Control}");
  expect(await screen.findByRole("textbox")).toHaveValue("payments");
  expect(moduleLoaded).toHaveBeenCalledTimes(1);
  useUi.setState({ paletteOpen: false });
});
