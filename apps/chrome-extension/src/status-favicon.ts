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
// Tab icons: the lattice (Aeon's mark) at rest, a turning violet nebula while the chat works, and
// a still blue nebula once it finished unseen. Frames are drawn once and stepped evenly, so the
// turn stays smooth when timers jitter.
const FRAMES = 24;
const spinnerFrames: string[] = [];
const VIOLET = ["#f3efff", "#b9a6ff", "#6d4ce6"] as const;
const BLUE = ["#eaf4ff", "#7db7ff", "#2f6fe0"] as const;
const NEBULA = Array.from({ length: 140 }, (_, index) => {
  const y = 1 - (index / 139) * 2;
  const ring = Math.sqrt(1 - y * y);
  const turn = index * 2.39996;
  return [Math.cos(turn) * ring, y, Math.sin(turn) * ring] as const;
});
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
  // Only a chat's own tab spins while that chat works; other Aeon pages keep their normal icon.
  working = Boolean(chatFilter) && values.includes("working");
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
  drawNebula(context, (index / FRAMES) * Math.PI * 2, VIOLET);
  return (spinnerFrames[index] = canvas.toDataURL("image/png"));
}
/** A small nebula on a dark disc, so it reads on light and dark tab strips. */
function drawNebula(
  target: CanvasRenderingContext2D,
  angle: number,
  [near, middle, far]: readonly [string, string, string],
): void {
  target.clearRect(0, 0, 32, 32);
  target.globalCompositeOperation = "source-over";
  target.globalAlpha = 1;
  target.fillStyle = "#0b0a10";
  target.beginPath();
  target.arc(16, 16, 15.5, 0, Math.PI * 2);
  target.fill();
  target.globalCompositeOperation = "lighter";
  const tilt = 0.35;
  for (const [x, y0, z0] of NEBULA) {
    const y = y0 * Math.cos(tilt) - z0 * Math.sin(tilt);
    const z = y0 * Math.sin(tilt) + z0 * Math.cos(tilt);
    const depth = (x * Math.sin(angle) + z * Math.cos(angle) + 1) / 2;
    target.globalAlpha = 0.1 + 0.9 * depth * depth;
    target.fillStyle = depth > 0.72 ? near : depth > 0.4 ? middle : far;
    const px = 16 + (x * Math.cos(angle) - z * Math.sin(angle)) * 11;
    target.beginPath();
    target.arc(px, 16 + y * 11, 0.5 + depth * 0.9, 0, Math.PI * 2);
    target.fill();
  }
  target.globalCompositeOperation = "source-over";
  target.globalAlpha = 1;
}
function draw(): void {
  if (!context) return;
  if (working) {
    icon.href = spinnerFrame(frame);
    return;
  }
  context.clearRect(0, 0, 32, 32);
  if (done) drawNebula(context, 0.6, BLUE);
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
