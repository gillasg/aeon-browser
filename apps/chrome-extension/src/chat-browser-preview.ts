// Small live thumbnail of the tab this chat's agent is working in when that tab is not visible.
interface PreviewMessage {
  kind: "aeon.browser.preview";
  chatId: string;
  tabId: number;
  title: string;
  url: string;
  image: string | null;
}

export function installBrowserPreview(chatId: string | undefined): void {
  if (!chatId) return;
  let card: HTMLButtonElement | undefined;
  chrome.runtime.onMessage.addListener((message: PreviewMessage) => {
    if (message?.kind !== "aeon.browser.preview" || message.chatId !== chatId) return;
    if (!message.image) {
      card?.remove();
      card = undefined;
      return;
    }
    card ??= createCard();
    card.dataset.tabId = String(message.tabId);
    (card.querySelector("img") as HTMLImageElement).src = message.image;
    (card.querySelector("span") as HTMLSpanElement).textContent =
      message.title || hostOf(message.url) || "Working in a background tab";
  });
  function createCard(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "aeon-browser-preview";
    button.title = "Show the tab the agent is working in";
    button.innerHTML = '<img alt="" /><span></span>';
    button.addEventListener("click", () => {
      const tabId = Number(button.dataset.tabId);
      if (Number.isSafeInteger(tabId)) void chrome.tabs.update(tabId, { active: true });
    });
    document.body.append(button);
    return button;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
