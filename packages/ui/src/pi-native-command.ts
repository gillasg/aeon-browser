import type { ChatSurfaceProps } from "./chat-surface.js";
export const UI_BUILTIN_COMMANDS = new Set([
  "/tree",
  "/compact",
  "/model",
  "/thinking",
  "/settings",
  "/new",
  "/resume",
  "/fork",
]);
export function invokePiCommand(invocation: string, props: ChatSurfaceProps): void {
  switch (invocation) {
    case "/tree":
      focusTree();
      return;
    case "/compact":
      props.onCompact();
      return;
    case "/model":
      clickPicker("model-picker");
      props.onTogglePiUi();
      return;
    case "/thinking":
      clickPicker("thinking-picker");
      props.onTogglePiUi();
      return;
    case "/settings":
      props.onTogglePiUi();
      openSettings();
      return;
    case "/new":
      props.onNewChat();
      return;
    case "/resume":
      props.onTogglePiUi();
      props.onToggleSidebar();
      return;
    case "/fork": {
      forkAtLastUser(props);
      return;
    }
    default:
      props.onInsertCommand(invocation);
  }
}

function forkAtLastUser(props: ChatSurfaceProps): void {
  const row = [...props.rows]
    .reverse()
    .find((row) => row.kind === "entry" && row.entry.message?.role === "user");
  if (row?.kind === "entry" && props.onBranchMessage) void props.onBranchMessage(row.entry.entryId);
}
function clickPicker(id: string): void {
  document.getElementById(id)?.click();
}
function focusTree(): void {
  document.querySelector<HTMLButtonElement>(".pi-tree-entry")?.focus();
}

function openSettings(): void {
  document.getElementById("chat-settings-toggle")?.click();
}
