import type { HomeRunPreview } from "@aeon/ui";

// Live frames for home's running cards. The engine streams a frame of the tab each chat's agent is
// working in (`aeon.browser.preview`, about once a second); home keeps the latest per chat and
// drops it when that tab's preview ends.

interface PreviewMessage {
  kind?: string;
  chatId?: string;
  tabId?: number;
  latest?: boolean;
  title?: string;
  url?: string;
  image?: string | null;
}

export function followHomePreviews(
  onChange: (previews: ReadonlyMap<string, HomeRunPreview>) => void,
): void {
  const previews = new Map<string, HomeRunPreview & { tabId: number }>();
  chrome.runtime.onMessage.addListener((raw: unknown) => {
    const message = raw as PreviewMessage | null;
    if (message?.kind !== "aeon.browser.preview" || typeof message.chatId !== "string") return;
    if (typeof message.tabId !== "number") return;
    const current = previews.get(message.chatId);
    if (message.image && message.latest !== false)
      previews.set(message.chatId, {
        tabId: message.tabId,
        image: message.image,
        title: caption(message),
      });
    else if (!message.image && current?.tabId === message.tabId) previews.delete(message.chatId);
    else return;
    onChange(new Map(previews));
  });
}

function caption(message: PreviewMessage): string {
  try {
    const host = new URL(message.url ?? "").hostname.replace(/^www\./, "");
    if (host) return host;
  } catch {
    // Fall back to the page title.
  }
  return message.title || "Working in another tab";
}
