// Keeps each orb event in one place.
// - A run that needs the user is counted in chrome.storage.session; the worker turns the count
//   into the toolbar badge, and every island shows the total.
// - A result seen in the island marks the chat read, so Chrome doesn't also notify about it.

const NEEDS_PREFIX = "aeon-orb-needs:";

export function needsKey(tabId: number): string {
  return NEEDS_PREFIX + tabId;
}

/** The value is the chat that needs the user, so home can mark that chat's card. */
export async function setNeeds(tabId: number, needs: boolean, chatId = ""): Promise<void> {
  if (needs) await chrome.storage.session.set({ [needsKey(tabId)]: chatId });
  else await chrome.storage.session.remove(needsKey(tabId));
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
