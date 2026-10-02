/** Keep the panel caption aligned with its own same-origin Chat view's native title. */
export function observePanelFrameTitle(
  root: HTMLElement,
  selectedChat: () => string,
  update: (chatId: string, title: string) => void,
): () => void {
  let observer: MutationObserver | undefined;
  const onLoad = (event: Event) => {
    const frame = event.target;
    if (!(frame instanceof HTMLIFrameElement) || frame.id !== "chat-frame") return;
    observer?.disconnect();
    const doc = frame.contentDocument;
    if (!doc?.head) return;
    const apply = () => {
      const url = new URL(doc.URL);
      const chatId = url.searchParams.get("chatId");
      if (url.origin !== location.origin || url.pathname !== "/chat.html") return;
      if (!chatId || chatId !== selectedChat()) return;
      const title = doc.title.replace(/ · (?:Pippin|Piper|Aeon)$/, "").trim();
      if (title && title.length <= 120) update(chatId, title);
    };
    observer = new MutationObserver(apply);
    observer.observe(doc.head, { childList: true, subtree: true, characterData: true });
    apply();
  };
  root.addEventListener("load", onLoad, true);
  return () => {
    root.removeEventListener("load", onLoad, true);
    observer?.disconnect();
  };
}
