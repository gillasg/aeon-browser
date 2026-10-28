// Which chats are working and which wait for the user, from the session-storage mirrors the
// worker (aeon-chat-working-<chatId>) and orbs (aeon-orb-needs:<tabId> → chatId) keep. For the
// chat switcher's dots and the orb's swarm.
const WORKING_PREFIX = "aeon-chat-working-";
const NEEDS_PREFIX = "aeon-orb-needs:";

export interface ChatRunState {
  running: ReadonlySet<string>;
  needs: ReadonlySet<string>;
}

export function watchChatRunState(onChange: (state: ChatRunState) => void): void {
  const read = async (): Promise<void> => {
    const values = (await chrome.storage.session.get(null).catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const entries = Object.entries(values);
    onChange({
      running: new Set(
        entries
          .filter(([key, value]) => key.startsWith(WORKING_PREFIX) && value === "working")
          .map(([key]) => key.slice(WORKING_PREFIX.length)),
      ),
      needs: new Set(
        entries
          .filter(([key, value]) => key.startsWith(NEEDS_PREFIX) && typeof value === "string")
          .map(([, value]) => value as string),
      ),
    });
  };
  chrome.storage.session.onChanged.addListener((changes) => {
    if (
      Object.keys(changes).some(
        (key) => key.startsWith(WORKING_PREFIX) || key.startsWith(NEEDS_PREFIX),
      )
    )
      void read();
  });
  void read();
}
