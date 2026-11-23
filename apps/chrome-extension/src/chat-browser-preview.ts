// Live previews of the tabs this chat's agent works in, from the engine's one screenshot loop
// (native-browser-preview.ts). The engine sends no image for a tab the user can already see, so
// work on the tab in front shows no thumbnail at all. Work in another tab shows a compact live
// tile, the size of the send button, in the side panel's work area and in the cursor box; a click
// morphs it to the full width with the tab's title and a Jump to tab, and it melts away when the
// work there ends.
interface PreviewMessage {
  kind: "aeon.browser.preview";
  chatId: string;
  tabId: number;
  view?: "split" | "thumbnails";
  latest?: boolean;
  title: string;
  url: string;
  image: string | null;
}

const MELT_MS = 240;

/** `chatId` may be a getter: the cursor box has no chat until its first message. */
export function installBrowserPreview(
  chatId: string | undefined | (() => string | undefined),
  mount: HTMLElement = document.body,
): void {
  const current = typeof chatId === "function" ? chatId : () => chatId;
  if (typeof chatId !== "function" && !chatId) return;
  const strip = document.createElement("div");
  strip.className = "aeon-browser-previews";
  mount.append(strip);
  const cards = new Map<number, HTMLDivElement>();
  chrome.runtime.onMessage.addListener((message: PreviewMessage) => {
    const id = current();
    if (message?.kind !== "aeon.browser.preview" || !id || message.chatId !== id) return;
    strip.dataset.view = message.view ?? "split";
    if (!message.image) return melt(cards, message.tabId);
    show(cardFor(cards, message.tabId, id, strip), cards, message);
  });
}

function cardFor(
  cards: Map<number, HTMLDivElement>,
  tabId: number,
  chatId: string,
  strip: HTMLElement,
): HTMLDivElement {
  const card = cards.get(tabId);
  if (card && !card.classList.contains("leaving")) return card;
  card?.remove();
  const fresh = createCard(tabId, chatId, strip);
  cards.set(tabId, fresh);
  strip.append(fresh);
  return fresh;
}

function show(
  card: HTMLDivElement,
  cards: Map<number, HTMLDivElement>,
  message: PreviewMessage,
): void {
  card.dataset.view = message.view ?? "split";
  if (message.latest) for (const other of cards.values()) other.classList.remove("latest");
  card.classList.toggle("latest", Boolean(message.latest));
  (card.querySelector("img") as HTMLImageElement).src = message.image ?? "";
  (card.querySelector(".aeon-preview-title") as HTMLSpanElement).textContent =
    message.title || hostOf(message.url) || "Working in another tab";
}

function melt(cards: Map<number, HTMLDivElement>, tabId: number): void {
  const card = cards.get(tabId);
  if (!card) return;
  cards.delete(tabId);
  card.classList.add("leaving");
  if (card.classList.contains("expanded")) card.parentElement?.classList.remove("expanded");
  setTimeout(() => card.remove(), MELT_MS);
}

function createCard(tabId: number, chatId: string, strip: HTMLElement): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "aeon-browser-preview";
  card.innerHTML =
    '<button type="button" class="aeon-preview-thumb" aria-expanded="false">' +
    '<img alt="" /></button>' +
    '<div class="aeon-preview-meta"><span class="aeon-preview-title"></span>' +
    '<button type="button" class="aeon-preview-jump">Jump to tab</button></div>';
  const thumb = card.querySelector(".aeon-preview-thumb") as HTMLButtonElement;
  thumb.title = "Show what Aeon is doing in the other tab";
  thumb.addEventListener("click", () => {
    const open = !card.classList.contains("expanded");
    for (const other of strip.children) other.classList.remove("expanded");
    card.classList.toggle("expanded", open);
    strip.classList.toggle("expanded", open);
    thumb.setAttribute("aria-expanded", String(open));
  });
  card.querySelector(".aeon-preview-jump")?.addEventListener("click", () => {
    if (card.dataset.view === "thumbnails")
      void chrome.runtime
        .sendMessage({ kind: "aeon.browser.expand", chatId, tabId })
        .catch(() => undefined);
    else void jump(tabId);
  });
  return card;
}

async function jump(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
  if (tab?.windowId !== undefined)
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
