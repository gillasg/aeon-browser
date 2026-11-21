// The hand-off's typed answer lives in the tab's isolated world, never in the page's own world:
// page scripts cannot enumerate the field, read what the user types, or answer for them. The
// main-world painter still draws the amber cursor and its message; this host collects Done,
// Cancel and the typed answer and sends them to the extension worker over runtime messaging.
import type { HandoffMeta } from "@browserkit/protocol";
import { CURSOR_TOKEN_CSS } from "./cursor-mark.js";

export const HANDOFF_ASK_ID = "aeon-agent-ask";

const ASK_CSS =
  ":host{all:initial}.ask{display:flex;align-items:center;gap:6px;width:320px;padding:5px 5px 5px 12px;" +
  "border-radius:var(--aeon-r-full);background:var(--aeon-island-bg);color:var(--aeon-island-ink);" +
  "font:500 var(--aeon-fs-md)/17px system-ui,-apple-system,Segoe UI,sans-serif;pointer-events:auto;" +
  "box-shadow:0 6px 18px var(--aeon-island-shadow)}" +
  ".ask input{flex:1;min-width:0;height:28px;border:0;border-radius:var(--aeon-r-full);padding:0 12px;" +
  "background:var(--aeon-island-field);color:var(--aeon-island-ink);font:inherit;outline:none}" +
  ".ask input::placeholder{color:var(--aeon-island-ink-soft)}" +
  ".ask button{border:0;border-radius:var(--aeon-r-full);padding:5px 13px;cursor:pointer;" +
  "font:600 var(--aeon-fs-sm)/16px system-ui,-apple-system,Segoe UI,sans-serif;" +
  "background:var(--aeon-island-ink);color:var(--aeon-island-needs-ink)}" +
  ".ask button.cancel{width:24px;height:24px;padding:0;display:grid;place-items:center;" +
  "background:var(--aeon-island-line-strong);color:var(--aeon-island-ink)}";

interface AskDetail {
  style: string;
  tabId: number;
  point?: { x: number; y: number };
  /** Names the confirm button after the commitment ("Pay $42.10") instead of "Done". */
  confirm?: string;
}

/** Adds the ask to the tab. A closed shadow root keeps the input out of the page's DOM queries. */
export async function showHandoffAsk(
  tabId: number,
  point?: { x: number; y: number },
  meta: HandoffMeta = {},
): Promise<void> {
  await chrome.scripting
    .executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: showAsk,
      args: [
        {
          style: CURSOR_TOKEN_CSS + ASK_CSS,
          tabId,
          ...(point ? { point } : {}),
          ...(meta.kind === "cliff-edge" && meta.actionLabel ? { confirm: meta.actionLabel } : {}),
        },
      ],
    })
    .catch(() => undefined);
}

/** Removes the ask and its listener: an idle page carries nothing of the hand-off. */
export async function hideHandoffAsk(tabId: number): Promise<void> {
  await chrome.scripting
    .executeScript({ target: { tabId }, world: "ISOLATED", func: removeAsk })
    .catch(() => undefined);
}

/** Runs in the tab's isolated world. Helpers are nested so the serialised function is whole. */
function showAsk(detail: AskDetail): void {
  const id = "aeon-agent-ask";
  const old = document.getElementById(id);
  if (old) old.remove();
  const host = document.createElement("div");
  host.id = id;
  host.setAttribute("data-aeon-overlay", "");
  host.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "closed" });
  function send(value: "done" | "cancelled" | { answer: string }): void {
    chrome.runtime
      .sendMessage({ kind: "aeon.handoff.answer", tabId: detail.tabId, answer: value })
      .catch(() => undefined);
    host.dispatchEvent(new Event("aeon-ask-remove"));
    host.remove();
  }
  function finish(): void {
    const text = field.value.trim().slice(0, 2000);
    send(text ? { answer: text } : "done");
  }
  function makeButton(kind: string, label: string, run: () => void): HTMLButtonElement {
    const node = document.createElement("button");
    node.className = kind;
    node.textContent = label;
    node.setAttribute("aria-label", kind === "cancel" ? "Cancel" : label);
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      run();
    });
    return node;
  }
  function makeStyle(): HTMLStyleElement {
    const node = document.createElement("style");
    node.textContent = detail.style;
    return node;
  }
  // The cursor publishes its point over a neutral event, never in the page DOM. This ask lives in
  // the isolated world and listens there, so page scripts cannot read where the cursor is either.
  let cursorPoint = detail.point;
  function onState(event: Event): void {
    const state = (event as CustomEvent<{ point?: { x: number; y: number } }>).detail;
    if (state?.point && typeof state.point.x === "number") cursorPoint = state.point;
    place();
  }
  window.addEventListener("cursor-overlay-state", onState);
  host.addEventListener("aeon-ask-remove", () =>
    window.removeEventListener("cursor-overlay-state", onState),
  );
  function place(): void {
    const point: { x?: unknown; y?: unknown } = cursorPoint ?? {};
    const x = typeof point.x === "number" ? point.x + 14 : window.innerWidth / 2 - 160;
    const y = typeof point.y === "number" ? point.y + 44 : window.innerHeight - 120;
    host.style.left = Math.max(8, Math.min(window.innerWidth - 328, x)) + "px";
    host.style.top = Math.max(8, Math.min(window.innerHeight - 52, y)) + "px";
  }
  const field = document.createElement("input");
  field.type = "text";
  field.placeholder = "Or type the answer here…";
  field.setAttribute("aria-label", "Type the answer");
  field.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.isComposing) finish();
  });
  for (const kind of ["keyup", "keypress", "input"])
    field.addEventListener(kind, (event) => event.stopPropagation());
  const row = document.createElement("div");
  row.className = "ask";
  row.append(
    field,
    makeButton("done", detail.confirm ?? "Done", finish),
    makeButton("cancel", "✕", () => send("cancelled")),
  );
  root.append(makeStyle(), row);
  place();
  (document.documentElement || document.body).append(host);
}

/** Runs in the tab's isolated world: drops the ask without touching anything else. */
function removeAsk(): void {
  const ask = document.getElementById("aeon-agent-ask");
  if (!ask) return;
  ask.dispatchEvent(new Event("aeon-ask-remove"));
  ask.remove();
}
