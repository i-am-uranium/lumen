import { Bot, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopilotUi } from "@/state/copilotUi";
import { cn } from "@/lib/utils";

export function CopilotLauncher() {
  const isOpen = useCopilotUi((s) => s.isOpen);
  const activeSessionId = useCopilotUi((s) => s.activeSessionId);
  const openDrawer = useCopilotUi((s) => s.openDrawer);

  if (isOpen) return null;

  return (
    <Button
      type="button"
      size="sm"
      onClick={() => openDrawer()}
      className={cn(
        "fixed bottom-5 right-5 z-40 h-11 rounded-full border border-accent-primary/35 px-4 shadow-[var(--shadow-popover)]",
        "bg-accent-primary text-white hover:bg-accent-primary-hover",
      )}
      aria-label={activeSessionId ? "open Copilot investigation" : "open Copilot"}
      title={activeSessionId ? "open Copilot investigation" : "open Copilot"}
    >
      {activeSessionId ? <MessageCircle className="size-4" /> : <Bot className="size-4" />}
      Copilot
    </Button>
  );
}
