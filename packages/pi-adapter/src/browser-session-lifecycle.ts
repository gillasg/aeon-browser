import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BrowserToolRunner } from "./browser-tool.js";
export function installBrowserSessionLifecycle(
  session: AgentSession,
  chatId: string,
  run?: BrowserToolRunner,
): void {
  session.subscribe((event) => {
    if (event.type === "agent_end")
      void run?.(chatId, "browser-turn-cleanup", { release: true }).catch(() => undefined);
  });
}
