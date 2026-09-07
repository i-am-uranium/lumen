import { invoke } from "@tauri-apps/api/core";
import { useUiSettings } from "@/state/uiSettings";

export type ContextProtection = {
  context: string;
  protected: boolean;
  unlocked_until_ms: number | null;
  can_mutate: boolean;
};

export const contextProtection = {
  get: (context: string) => invoke<ContextProtection>("get_context_protection", { context }),
  set: (context: string, protectedContext: boolean) => invoke<ContextProtection>("set_context_protection", { context, protected: protectedContext }),
  unlock: (context: string) => invoke<ContextProtection>("unlock_context", { context }),
  lock: (context: string) => invoke<ContextProtection>("lock_context", { context }),
};

/** Native status grants permission; a local clock can only shorten that grant. */
export function canMutateContext(status: ContextProtection | undefined, context: string, now = Date.now()): boolean {
  return !!context && status?.context === context && status.can_mutate === true &&
    (status.protected === false || (status.protected === true && typeof status.unlocked_until_ms === "number" && status.unlocked_until_ms > now));
}

/** Always refresh before dispatch. Native code repeats the check at the side effect. */
export async function assertContextMutation(context: string | undefined): Promise<void> {
  if (!context?.trim()) throw new Error("An explicit target context is required for this action.");
  if (useUiSettings.getState().readOnly) throw new Error("Global read-only mode is enabled.");
  const status = await contextProtection.get(context);
  if (useUiSettings.getState().readOnly) throw new Error("Global read-only mode is enabled.");
  if (!canMutateContext(status, context)) throw new Error(`Context ${context} is locked or protection status is unavailable. Unlock this context before making changes.`);
}

export function protectionErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return typeof error === "string" ? error : "Protection status unavailable";
}
