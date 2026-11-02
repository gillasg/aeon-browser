import type { ChatService } from "./chat-service.js";
export function installChatPreparation(service: ChatService): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = service.subscribeAllEvents((_chatId, event) => {
    if (event.kind !== "run-state" || event.state !== "idle" || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void prepareChat(service);
    }, 300);
    timer.unref();
  });
  return () => {
    service.closePreparation();
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
export async function prepareChat(service: ChatService): Promise<void> {
  try {
    await service.prepareNextDraft();
  } catch {
    process.stderr.write(
      "Core resource preparation failed; the next session will report its setup error.\n",
    );
  }
}

/**
 * Loading the user's Pi extensions and packages is mostly synchronous and takes tens of seconds
 * when cold, which starves the event loop. Started during startup it held back readiness by
 * that long, so it starts only after the daemon answers and the extension has connected.
 */
export function warmAfterReady(service: ChatService, delayMs = 2000): void {
  setTimeout(() => void prepareChat(service), delayMs).unref();
}
