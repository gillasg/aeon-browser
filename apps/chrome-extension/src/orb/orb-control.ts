// Shows which tab the agent is driving, and keeps each event in one place.
// - The tab joins a purple "Aeon" tab group while the run works, and leaves it after (only if
//   Aeon put it there).
// - A run that needs the user is counted in chrome.storage.session; the worker turns the count
//   into the toolbar badge, and every island shows the total.
// - A result seen in the island marks the chat read, so Chrome doesn't also notify about it.

const GROUP_TITLE = "Aeon";
const NEEDS_PREFIX = "aeon-orb-needs:";

export class TabControl {
  private grouped = false;

  constructor(private readonly tabId: number) {}

  async hold(): Promise<void> {
    if (this.grouped) return;
    const tab = await chrome.tabs.get(this.tabId).catch(() => undefined);
    // A tab already in the user's own group stays there.
    if (!tab || tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
    try {
      const groupId = await chrome.tabs.group({ tabIds: this.tabId });
      await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "purple" });
      this.grouped = true;
    } catch {
      /* Pinned tabs and some windows can't be grouped. */
    }
  }

  async release(): Promise<void> {
    if (!this.grouped) return;
    this.grouped = false;
    await chrome.tabs.ungroup(this.tabId).catch(() => undefined);
  }
}

export function needsKey(tabId: number): string {
  return NEEDS_PREFIX + tabId;
}

/** The value is the chat that needs the user, so home can mark that chat's card. */
export async function setNeeds(tabId: number, needs: boolean, chatId = ""): Promise<void> {
  if (needs) await chrome.storage.session.set({ [needsKey(tabId)]: chatId });
  else await chrome.storage.session.remove(needsKey(tabId));
}

export async function needsCount(): Promise<number> {
  const values = await chrome.storage.session.get(null);
  return Object.keys(values).filter((key) => key.startsWith(NEEDS_PREFIX)).length;
}

export function isNeedsKey(key: string): boolean {
  return key.startsWith(NEEDS_PREFIX);
}

/** Tells Core the result was seen here, the way chat tabs do, so no notification follows. */
export async function markSeen(chatId: string, viewId: string): Promise<void> {
  if (document.visibilityState !== "visible") return;
  const key = "aeon-completion-id-" + chatId;
  const completionId = ((await chrome.storage.session.get(key))[key] as string | undefined) ?? null;
  await chrome.runtime
    .sendMessage({ kind: "core.attention.read", chatId, completionId, viewId, visible: true })
    .catch(() => undefined);
}
