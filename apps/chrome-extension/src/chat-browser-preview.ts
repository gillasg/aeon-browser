// Live previews of the tabs this chat's agent works in. In split view: one small card for the
// last-touched tab while it is out of sight. In thumbnail view: a vertical strip on the right with
// one live thumbnail per tab, the last-touched one highlighted; clicking one opens it in split.
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

export function installBrowserPreview(chatId: string | undefined): void {
  if (!chatId) return;
  const strip = document.createElement("div");
  strip.className = "aeon-browser-previews";
  document.body.append(strip);
  const cards = new Map<number, HTMLButtonElement>();
  chrome.runtime.onMessage.addListener((message: PreviewMessage) => {
    if (message?.kind !== "aeon.browser.preview" || message.chatId !== chatId) return;
    const view = message.view ?? "split";
    strip.dataset.view = view;
    if (!message.image) {
      cards.get(message.tabId)?.remove();
      cards.delete(message.tabId);
      return;
    }
    let card = cards.get(message.tabId);
    if (!card) {
      card = createCard(message.tabId, chatId);
      cards.set(message.tabId, card);
      strip.append(card);
    }
    card.dataset.view = view;
    if (message.latest) for (const other of cards.values()) other.classList.remove("latest");
    card.classList.toggle("latest", Boolean(message.latest));
    (card.querySelector("img") as HTMLImageElement).src = message.image;
    (card.querySelector("span") as HTMLSpanElement).textContent =
      message.title || hostOf(message.url) || "Working in a background tab";
  });
}

function createCard(tabId: number, chatId: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "aeon-browser-preview";
  button.title = "Show the tab the agent is working in";
  button.innerHTML = '<img alt="" /><span></span>';
  button.addEventListener("click", () => {
    if (button.dataset.view === "thumbnails")
      void chrome.runtime
        .sendMessage({ kind: "aeon.browser.expand", chatId, tabId })
        .catch(() => undefined);
    else void chrome.tabs.update(tabId, { active: true });
  });
  return button;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
