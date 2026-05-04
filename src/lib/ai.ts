import { invoke } from "@tauri-apps/api/core";

export type AiProviderStatus = {
  id: "codex" | "claude";
  label: string;
  command: string;
  available: boolean;
  path: string | null;
  command_preview: string;
};

export type AiRunResult = {
  provider: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
};

export const ai = {
  detectProviders: () => invoke<AiProviderStatus[]>("detect_ai_providers"),
  runPrompt: (provider: string, prompt: string) =>
    invoke<AiRunResult>("run_ai_prompt", { request: { provider, prompt } }),
};
