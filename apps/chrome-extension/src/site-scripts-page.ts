import { applyStoredTheme } from "./theme-preferences.js";
import { readScripts, SCRIPT_KEY } from "./site-script-records.js";
applyStoredTheme();
document.getElementById("extension-details")?.addEventListener("click", () => {
  void chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id });
});
document.getElementById("refresh")?.addEventListener("click", () => void render());
chrome.storage.onChanged.addListener(() => void render());
async function render(): Promise<void> {
  const status = document.getElementById("script-access");
  try {
    await chrome.userScripts.getScripts();
    if (status) status.textContent = "User scripts are enabled.";
  } catch {
    if (status) status.textContent = "Open extension details and switch on Allow User Scripts.";
  }
  const stored = await chrome.storage.local.get([
    SCRIPT_KEY,
    "aeon-site-script-access",
    "aeon-site-script-errors",
  ]);
  await renderAccess(stored["aeon-site-script-access"]);
  renderScripts(stored);
}
void render();

async function renderAccess(value: unknown): Promise<void> {
  const access = document.getElementById("site-access");
  access?.replaceChildren();
  const origins = Array.isArray(value) ? (value as string[]) : [];
  for (const origin of origins) {
    const allowed = await chrome.permissions.contains({ origins: [origin] });
    const row = document.createElement("p"),
      label = document.createElement("span");
    label.textContent = new URL(origin).hostname + " ";
    row.append(label);
    const button = document.createElement("button");
    button.textContent = allowed ? "Allowed" : "Allow site";
    button.disabled = allowed;
    button.addEventListener("click", () => {
      void chrome.permissions.request({ origins: [origin] }).then(() => render());
    });
    row.append(button);
    access?.append(row);
  }
}
function renderScripts(stored: Record<string, unknown>): void {
  const list = document.getElementById("scripts");
  list?.replaceChildren();
  const scripts = readScripts(stored[SCRIPT_KEY]);
  if (list && !scripts.length) list.textContent = "No saved scripts yet.";
  for (const script of scripts) {
    const row = document.createElement("div");
    row.className = "script-row";
    const name = document.createElement("strong");
    name.textContent = script.name;
    const detail = document.createElement("span");
    detail.className = "script-detail";
    detail.textContent = `${script.enabled ? "Enabled" : "Disabled"} · revision ${script.revision} · ${script.matches.join(", ")} · ${script.scriptId}`;
    row.append(name, detail);
    const error = (stored["aeon-site-script-errors"] as Record<string, unknown> | undefined)?.[
      script.scriptId
    ];
    if (error) {
      const message = document.createElement("p");
      message.textContent = String(error);
      row.append(message);
    }
    list?.append(row);
  }
}
