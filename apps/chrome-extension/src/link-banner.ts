// Last-resort banner: shown only when the browser link stays down after self-healing gave up.
// The worker records the link state in chrome.storage.local ("aeon-link", see link-state.ts).

const KEY = "aeon-link";

export function installLinkBanner(): void {
  const banner = document.createElement("div");
  banner.className = "link-banner";
  banner.hidden = true;
  banner.setAttribute("role", "alert");
  const text = document.createElement("span");
  text.textContent = "Aeon lost its browser link and couldn't reconnect.";
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload Aeon";
  reload.addEventListener("click", () => chrome.runtime.reload());
  banner.append(text, reload);
  document.body.append(banner);
  const show = (value: unknown): void => {
    banner.hidden = (value as { state?: string } | undefined)?.state !== "down";
  };
  void chrome.storage.local.get(KEY).then(
    (stored) => show(stored[KEY]),
    () => undefined,
  );
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) show(changes[KEY].newValue);
  });
}
