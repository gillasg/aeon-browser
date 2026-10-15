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
let frame = 0;
let working = false;
let chatFilter = "";
// Spinner frames are drawn once and stepped evenly, so the turn stays smooth when timers jitter.
const FRAMES = 24;
const spinnerFrames: string[] = [];
/** Limits this tab's icon to one chat's status (chat pages); other pages show any chat's. */
export function showStatusForChat(chatId: string): void {
  chatFilter = chatId;
  refresh();
}
function relevant(key: string): boolean {
  return (
    !chatFilter || key === "aeon-chat-working-" + chatFilter || key === "piper-unread-" + chatFilter
  );
}
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
  const values = [...statuses].filter(([key]) => relevant(key)).map(([, value]) => value);
  working = values.includes("working");
  done = !working && values.includes("done");
  if (working && !timer)
    timer = window.setInterval(() => {
      frame = (frame + 1) % FRAMES;
      draw();
    }, 1200 / FRAMES);
  if (!working && timer) {
    clearInterval(timer);
    timer = 0;
    frame = 0;
  }
  draw();
}
function spinnerFrame(index: number): string {
  if (spinnerFrames[index] || !context) return spinnerFrames[index] ?? "";
  const angle = (index / FRAMES) * Math.PI * 2;
  context.clearRect(0, 0, 32, 32);
  context.strokeStyle = "#737373";
  context.lineWidth = 3;
  context.lineCap = "round";
  context.beginPath();
  context.arc(16, 16, 12, angle, angle + Math.PI * 1.5);
  context.stroke();
  return (spinnerFrames[index] = canvas.toDataURL("image/png"));
}
function draw(): void {
  if (!context) return;
  if (working) {
    icon.href = spinnerFrame(frame);
    return;
  }
  context.clearRect(0, 0, 32, 32);
  if (done) {
    context.fillStyle = "#4299ff";
    context.beginPath();
    context.arc(16, 16, 6, 0, Math.PI * 2);
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
