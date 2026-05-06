import { toast } from "sonner";

let updateCheckStarted = false;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function checkForAppUpdate(): Promise<void> {
  if (updateCheckStarted || !import.meta.env.PROD || !isTauriRuntime()) return;
  updateCheckStarted = true;

  try {
    const [{ check }, { relaunch }] = await Promise.all([
      import("@tauri-apps/plugin-updater"),
      import("@tauri-apps/plugin-process"),
    ]);

    const update = await check();
    if (!update) return;

    toast.info(`Installing Lumen ${update.version}...`);
    await update.downloadAndInstall();
    toast.success("Update installed. Restarting Lumen.");
    await relaunch();
  } catch (error) {
    console.warn("Lumen update check failed", error);
  }
}
