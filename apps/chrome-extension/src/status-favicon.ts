const prefix = "pippin-tab-status-";
const statuses = new Map<string, string>();
const canvas = document.createElement("canvas");
canvas.width = canvas.height = 32;
const context = canvas.getContext("2d");
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
    if (key.startsWith(prefix) || key.startsWith("piper-unread-")) {
      touchedKeys.add(key);
      if (typeof change.newValue === "string") statuses.set(key, change.newValue);
      else statuses.delete(key);
    }
  refresh();
});
void chrome.storage.session.get(null).then((values) => {
  for (const [key, value] of Object.entries(values))
    if (key.startsWith(prefix) && !touchedKeys.has(key) && typeof value === "string")
      statuses.set(key, value);
  refresh();
});
function refresh(): void {
  working = [...statuses.values()].includes("working");
  done = [...statuses.values()].includes("done");
  if (working && !timer)
    timer = window.setInterval(() => {
      angle += Math.PI / 8;
      draw();
    }, 100);
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
  if (!working && !done) {
    context.strokeStyle = "#737373";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(16, 16, 6, 0, Math.PI * 2);
    context.stroke();
  }
  icon.href = canvas.toDataURL("image/png");
}
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
draw();
