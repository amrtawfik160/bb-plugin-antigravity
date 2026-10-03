import type { PluginSettingsClient } from "./provider-acp-agents.js";

export async function waitForProviderAcp(
  client: PluginSettingsClient,
  signal: AbortSignal,
  options = { attempts: 30, delayMs: 1000 },
): Promise<void> {
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    signal.throwIfAborted();
    try {
      await client.getSettings({ pluginId: "provider-acp" });
      return;
    } catch (error) {
      const missing = typeof error === "object" && error !== null &&
        (("status" in error && error.status === 404) ||
         ("statusCode" in error && error.statusCode === 404) ||
         (error instanceof Error && /HTTP 404|plugin.*not found/i.test(error.message)));
      if (!missing || attempt + 1 === options.attempts) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      const timer = setTimeout(finish, options.delayMs);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}
