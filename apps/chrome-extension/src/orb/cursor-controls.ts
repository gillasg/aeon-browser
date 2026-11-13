// The engine cursor's ☰ and ■. The page draws the glyphs; these buttons, created here in the
// isolated world, are the ones that act. A page-dispatched event is not trusted and does nothing.

import { CURSOR_STOP, CURSOR_TRANSCRIPT } from "./orb-messages.js";

export interface ControlBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CursorControls {
  tr: ControlBox | null;
  stop: ControlBox | null;
}

type Action = "transcript" | "stop";

interface ControlButtons {
  host: HTMLElement;
  transcript: HTMLButtonElement;
  stop: HTMLButtonElement;
}

export function acceptCursorClick(event: { isTrusted: boolean }): boolean {
  return event.isTrusted === true;
}

export function controlKind(action: Action, summoned: boolean): string {
  if (action === "transcript") return CURSOR_TRANSCRIPT;
  return summoned ? CURSOR_STOP : CURSOR_TRANSCRIPT;
}

export function parseControls(raw: string | undefined): CursorControls | null {
  if (!raw || raw.length > 400) return null;
  try {
    const parsed = JSON.parse(raw) as { tr?: unknown; stop?: unknown };
    return { tr: box(parsed.tr), stop: box(parsed.stop) };
  } catch {
    return null;
  }
}

/** The boxes worth mounting buttons for: no box on screen means nothing of ours in the page. */
export function controlsToShow(raw: string | undefined): CursorControls | null {
  const controls = parseControls(raw);
  return controls?.tr || controls?.stop ? controls : null;
}

export function startCursorControls(send: (kind: string) => void, summoned: () => boolean): void {
  let buttons: ControlButtons | undefined;
  // Nothing of ours in the page until there is something to click: the host is created for the
  // pill's two buttons and removed again when the pill is not showing its boxes.
  const sync = () => {
    const controls = controlsToShow(cursorAttribute());
    if (!controls) {
      buttons?.host.remove();
      buttons = undefined;
      return;
    }
    buttons ??= mountButtons((action, event) => {
      if (!acceptCursorClick(event)) return;
      event.preventDefault();
      event.stopPropagation();
      send(controlKind(action, summoned()));
    });
    raise(buttons.host);
    applyControls(buttons, controls);
  };
  watchCursor(sync);
  sync();
}

function mountButtons(onClick: (action: Action, event: MouseEvent) => void): ControlButtons {
  const host = document.createElement("div");
  host.id = "aeon-cursor-controls";
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent =
    "button{position:fixed;border:0;padding:0;margin:0;border-radius:50%;background:transparent;color:transparent;cursor:pointer;pointer-events:auto}button[hidden]{display:none}";
  const transcript = button("Open the transcript in the side panel");
  const stop = button("Stop");
  transcript.addEventListener("click", (event) => onClick("transcript", event));
  stop.addEventListener("click", (event) => onClick("stop", event));
  shadow.append(style, transcript, stop);
  document.documentElement.append(host);
  return { host, transcript, stop };
}

function button(label: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.hidden = true;
  node.setAttribute("aria-label", label);
  node.title = label;
  return node;
}

function applyControls(buttons: ControlButtons, controls: CursorControls | null): void {
  placeButton(buttons.transcript, controls?.tr ?? null);
  placeButton(buttons.stop, controls?.stop ?? null);
}

function placeButton(node: HTMLButtonElement, box: ControlBox | null): void {
  node.hidden = !box;
  if (!box) return;
  node.style.left = box.x + "px";
  node.style.top = box.y + "px";
  node.style.width = box.w + "px";
  node.style.height = box.h + "px";
}

function watchCursor(sync: () => void): void {
  let watched: Element | undefined;
  const hostObserver = new MutationObserver(sync);
  const attach = () => {
    const host = document.getElementById("aeon-agent-cursor");
    if (host === watched) return;
    watched = host ?? undefined;
    hostObserver.disconnect();
    if (host)
      hostObserver.observe(host, { attributes: true, attributeFilter: ["data-aeon-controls"] });
  };
  const rootObserver = new MutationObserver(() => {
    attach();
    sync();
  });
  rootObserver.observe(document.documentElement, { childList: true });
  attach();
}

function raise(host: HTMLElement): void {
  const parent = document.documentElement;
  if (parent.lastElementChild !== host) parent.append(host);
}

function cursorAttribute(): string | undefined {
  return document.getElementById("aeon-agent-cursor")?.dataset.aeonControls;
}

function box(value: unknown): ControlBox | null {
  if (!value || typeof value !== "object") return null;
  const item = value as { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
  const x = Number(item.x);
  const y = Number(item.y);
  const w = Number(item.w);
  const h = Number(item.h);
  if (![x, y, w, h].every((part) => Number.isFinite(part))) return null;
  if (w < 2 || h < 2 || w > 64 || h > 64) return null;
  return { x, y, w, h };
}
