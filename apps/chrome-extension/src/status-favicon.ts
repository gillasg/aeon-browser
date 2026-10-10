const prefix = "aeon-tab-status-";
const statuses = new Map<string, string>();
const canvas = document.createElement("canvas");
canvas.width = canvas.height = 32;
const context = canvas.getContext("2d");
const orbit = new Image();
orbit.src = "aeon-icon-32.png";
orbit.onload = () => draw();
const icon = document.createElement("link");
icon.rel = "icon";
icon.type = "image/png";
document.head.append(icon);
let timer = 0;
let angle = 0;
let working = false;
let done = false;
const touchedKeys = new Set<string>();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  for (const [key, change] of Object.entries(changes))
    if (
      key.startsWith(prefix) ||
      key.startsWith("piper-unread-") ||
      key.startsWith("aeon-chat-working-")
    ) {
      touchedKeys.add(key);
      if (typeof change.newValue === "string") statuses.set(key, change.newValue);
      else statuses.delete(key);
    }
  refresh();
  for (const key of Object.keys(changes)) {
    const chatId = statusChatId(key);
    if (chatId) publishChatStatus(chatId);
  }
});
void chrome.storage.session.get(null).then((values) => {
  for (const [key, value] of Object.entries(values))
    if (
      (key.startsWith(prefix) ||
        key.startsWith("piper-unread-") ||
        key.startsWith("aeon-chat-working-")) &&
      !touchedKeys.has(key) &&
      typeof value === "string"
    )
      statuses.set(key, value);
  refresh();
  for (const key of statuses.keys()) {
    const chatId = statusChatId(key);
    if (chatId) publishChatStatus(chatId);
  }
});
function refresh(): void {
  working = [...statuses.values()].includes("working");
  done = [...statuses.values()].includes("done");
  if (working && !timer)
    timer = window.setInterval(() => {
      angle = ((performance.now() % 1200) / 1200) * Math.PI * 2;
      draw();
    }, 1000 / 30);
  if (!working && timer) {
    clearInterval(timer);
    timer = 0;
    angle = 0;
  }
  draw();
}
function draw(): void {
  if (!context) return;
  context.clearRect(0, 0, 32, 32);
  if (working) {
    context.strokeStyle = "#737373";
    context.lineWidth = 3;
    context.lineCap = "round";
    context.beginPath();
    context.arc(16, 16, 12, angle, angle + Math.PI * 1.5);
    context.stroke();
  }
  if (done) {
    context.fillStyle = "#4299ff";
    context.beginPath();
    context.arc(16, 16, working ? 4 : 6, 0, Math.PI * 2);
    context.fill();
  }
  if (!working && !done && orbit.complete && orbit.naturalWidth)
    context.drawImage(orbit, 0, 0, 32, 32);
  icon.href = canvas.toDataURL("image/png");
}
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
draw();

window.addEventListener("aeon.chat-status-request", (event) => {
  const chatId = (event as CustomEvent).detail?.chatId;
  if (typeof chatId === "string") publishChatStatus(chatId);
});
function statusChatId(key: string): string | undefined {
  for (const prefix of ["aeon-chat-working-", "piper-unread-"])
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  return undefined;
}
function publishChatStatus(chatId: string): void {
  window.dispatchEvent(
    new CustomEvent("aeon.chat-status", {
      detail: {
        chatId,
        working: statuses.get("aeon-chat-working-" + chatId) === "working",
        unread: statuses.get("piper-unread-" + chatId) === "done",
      },
    }),
  );
}
