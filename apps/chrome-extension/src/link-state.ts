// The browser link's state, for a last-resort banner. The extension heals the link itself; this
// event exists so a surface can say "Aeon's browser link is down" only when waiting is not enough.

export type LinkState = "up" | "reconnecting" | "down";

export interface LinkEvent {
  kind: "aeon.link";
  state: LinkState;
  reason: string;
}

const STORAGE_KEY = "aeon-link";

export function reportLink(state: LinkState, reason: string): void {
  const event: LinkEvent = { kind: "aeon.link", state, reason };
  void chrome.storage.local.set({ [STORAGE_KEY]: event }).catch(() => undefined);
  void chrome.runtime.sendMessage(event).catch(() => undefined);
}
