// The first-install welcome: one line of status from the stored browser link, two setup steps
// while it is not up, and a side panel button. Nothing here writes or counts anything.

const STORAGE_KEY = "aeon-link";
const status = document.getElementById("status");
const setup = document.getElementById("setup");

function show(state: unknown): void {
  if (!status || !setup) return;
  const up = state === "up";
  status.dataset.state = up ? "up" : "down";
  status.textContent = up
    ? "Connected to Aeon on this computer."
    : "Not connected yet. Two steps finish it:";
  setup.hidden = up;
}

void chrome.storage.local.get(STORAGE_KEY).then(
  (items) => show((items[STORAGE_KEY] as { state?: unknown } | undefined)?.state),
  () => show(undefined),
);
chrome.runtime.onMessage.addListener((message: { kind?: unknown; state?: unknown } | null) => {
  if (message?.kind === "aeon.link") show(message.state);
});

document.getElementById("panel")?.addEventListener("click", () => {
  // sidePanel.open needs this click's user gesture, so it runs before anything awaits.
  void chrome.windows
    .getCurrent()
    .then((win) => (win.id === undefined ? undefined : chrome.sidePanel.open({ windowId: win.id })))
    .catch(() => undefined);
});
