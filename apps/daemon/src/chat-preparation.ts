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
