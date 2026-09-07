import { lazy, Suspense, useEffect, useState } from "react";
import { useShortcut } from "@/lib/shortcuts";
import { useUi } from "@/state/ui";

const CommandPalette = lazy(() =>
  import("./CommandPalette").then((module) => ({ default: module.CommandPalette })),
);

export function CommandPaletteHost() {
  const open = useUi((state) => state.paletteOpen);
  const [hasOpened, setHasOpened] = useState(open);

  // Register before loading the palette, so the first keyboard shortcut works.
  useShortcut("openPalette", () => {
    const state = useUi.getState();
    state.setPaletteOpen(!state.paletteOpen);
  });
  useEffect(() => {
    if (open) setHasOpened(true);
  }, [open]);

  // Keep it mounted after first use to preserve query state and dialog cleanup.
  if (!open && !hasOpened) return null;
  return (
    <Suspense fallback={<span role="status" className="sr-only">Opening command palette…</span>}>
      <CommandPalette />
    </Suspense>
  );
}
