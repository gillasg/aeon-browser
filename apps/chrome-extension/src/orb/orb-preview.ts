// Live view for the orb: when this run works in another tab (a background tab, another window),
// the engine streams a frame of that tab about once a second. The island shows the last-touched
// one under the live step; clicking it brings that tab forward.

export interface OrbPreview {
  tabId: number;
  image: string;
  title: string;
}

interface PreviewMessage {
  kind?: string;
  chatId?: string;
  tabId?: number;
  latest?: boolean;
  title?: string;
  url?: string;
  image?: string | null;
}

/** Follows the frames for one chat; `onChange` gets undefined when the preview should go. */
export function followPreviews(
  ownTabId: number,
  chatId: () => string | undefined,
  onChange: (preview: OrbPreview | undefined) => void,
): void {
  let current: OrbPreview | undefined;
  chrome.runtime.onMessage.addListener((raw: unknown) => {
    const message = raw as PreviewMessage | null;
    if (message?.kind !== "aeon.browser.preview" || !chatId()) return;
    if (message.chatId !== chatId() || typeof message.tabId !== "number") return;
    // The tab under the orb is already in front of the user; no picture of it is needed.
    const next =
      message.tabId !== ownTabId && message.image && message.latest !== false
        ? { tabId: message.tabId, image: message.image, title: caption(message) }
        : undefined;
    if (!next && current && current.tabId !== message.tabId) return;
    current = next;
    onChange(next);
  });
}

export function showPreviewTab(preview: OrbPreview | undefined): void {
  if (!preview) return;
  void chrome.tabs
    .update(preview.tabId, { active: true })
    .then((tab) => tab && chrome.windows.update(tab.windowId, { focused: true }))
    .catch(() => undefined);
}

function caption(message: PreviewMessage): string {
  if (message.title) return message.title;
  try {
    return new URL(message.url ?? "").hostname.replace(/^www\./, "");
  } catch {
    return "Working in another tab";
  }
}
