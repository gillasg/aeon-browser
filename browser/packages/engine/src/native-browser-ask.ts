// The hand-off's typed answer lives in the tab's isolated world, never in the page's own world:
// page scripts cannot enumerate the field, read what the user types, or answer for them. The
// main-world painter draws the cursor and the target's ring; this host is the card, with the
// message, I'm done, Skip and the typed answer and sends them to the extension worker over runtime messaging.
import type { HandoffMeta } from "@browserkit/protocol";
import { CURSOR_TOKEN_CSS } from "./cursor-mark.js";

export const HANDOFF_ASK_ID = "graft-agent-ask";

// The page's one hand-off card: the same neutral obsidian hairline as the cursor box, the agent's
// message in bone, `I'm done` as a dark-amber glass pill and a quiet Skip. Amber is the only
// colour Graft ever shows, and only on the controls that need your hand.
const ASK_CSS =
  ":host{all:initial}.ask{box-sizing:border-box;display:flex;flex-direction:column;gap:10px;width:320px;" +
  "max-width:calc(100vw - 32px);padding:13px 13px 11px 15px;border-radius:var(--graft-r-18);" +
  "background:var(--graft-island-needs);color:var(--graft-island-ink);-webkit-font-smoothing:antialiased;" +
  "font:400 var(--graft-fs-md)/1.5 -apple-system,BlinkMacSystemFont,system-ui,Segoe UI,sans-serif;pointer-events:auto;" +
  "letter-spacing:-0.011em;box-shadow:var(--graft-island-edge)}" +
  ".ask p{margin:0;color:var(--graft-island-ink);white-space:normal;overflow-wrap:anywhere}" +
  ".ask input{box-sizing:border-box;width:100%;height:30px;border:0;border-radius:var(--graft-r-full);padding:0 12px;" +
  "background:transparent;box-shadow:inset 0 0 0 1px var(--graft-island-needs-line);" +
  "color:var(--graft-island-ink);font:inherit;font-size:var(--graft-fs-sm);outline:none}" +
  ".ask input::placeholder{color:var(--graft-island-faint)}" +
  ".ask .row{display:flex;align-items:center;gap:6px}" +
  ".ask button{border:0;border-radius:var(--graft-r-full);padding:5px 12px;cursor:pointer;background:transparent;" +
  "font:500 var(--graft-fs-sm)/16px -apple-system,BlinkMacSystemFont,system-ui,Segoe UI,sans-serif}" +
  ".ask button:hover{background:var(--graft-island-wash)}" +
  ".ask button:focus-visible{outline:1px solid var(--graft-island-focus);outline-offset:1px}" +
  ".ask button.done{color:var(--graft-island-needs-ink);background:var(--graft-island-needs-hot);" +
  "box-shadow:inset 0 0 0 1px var(--graft-island-needs-line)}.ask button.cancel{color:var(--graft-island-muted)}";

interface AskDetail {
  style: string;
  tabId: number;
  point?: { x: number; y: number };
  /** The target's box: the card sits 12px beside it, never over its ring. */
  box?: { x: number; y: number; width: number; height: number };
  /** The agent's request, shown whole. */
  message?: string;
  /** Names the confirm button after the commitment ("Pay $42.10") instead of "Done". */
  confirm?: string;
}

/** Adds the ask to the tab. A closed shadow root keeps the input out of the page's DOM queries. */
export async function showHandoffAsk(
  tabId: number,
  point?: { x: number; y: number },
  meta: HandoffMeta = {},
  extra: { box?: { x: number; y: number; width: number; height: number }; message?: string } = {},
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
          ...(extra.box ? { box: extra.box } : {}),
          ...(extra.message ? { message: extra.message } : {}),
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
export function showAsk(detail: AskDetail): void {
  const id = "graft-agent-ask";
  const old = document.getElementById(id);
  if (old) old.remove();
  const host = document.createElement("div");
  host.id = id;
  host.setAttribute("data-ux-overlay", "");
  host.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none";
  const root = host.attachShadow({ mode: "closed" });
  function send(value: "done" | "cancelled" | { answer: string }): void {
    chrome.runtime
      .sendMessage({ kind: "graft.handoff.answer", tabId: detail.tabId, answer: value })
      .catch(() => undefined);
    host.dispatchEvent(new Event("graft-ask-remove"));
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
    node.setAttribute("aria-label", label);
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
  host.addEventListener("graft-ask-remove", () =>
    window.removeEventListener("cursor-overlay-state", onState),
  );
  // 12px below the target's ring (above it, or beside it, when there is no room), never over the
  // ring, and always whole inside the viewport with a 16px margin. Without a target it sits beside
  // the cursor; without either, bottom-centre.
  function place(): void {
    const margin = 16;
    const gap = 12;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const rect = row.getBoundingClientRect();
    const w = rect.width || 320;
    const h = rect.height || 96;
    const point: { x?: unknown; y?: unknown } = cursorPoint ?? {};
    const target = detail.box;
    let x = (width - w) / 2;
    let y = height - h - 80;
    if (target) {
      x = target.x;
      if (target.y + target.height + gap + h <= height - margin) y = target.y + target.height + gap;
      else if (target.y - gap - h >= margin) y = target.y - gap - h;
      else {
        y = target.y;
        x =
          target.x + target.width + gap + w <= width - margin
            ? target.x + target.width + gap
            : target.x - gap - w;
      }
    } else if (typeof point.x === "number" && typeof point.y === "number") {
      x = point.x + gap + w > width - margin ? point.x - gap - w : point.x + gap;
      y = point.y + 44 + h > height - margin ? point.y - 20 - h : point.y + 44;
    }
    host.style.left = Math.max(margin, Math.min(width - w - margin, x)) + "px";
    host.style.top = Math.max(margin, Math.min(height - h - margin, y)) + "px";
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
  row.setAttribute("role", "status");
  row.setAttribute("aria-label", "Graft needs you");
  const text = document.createElement("p");
  text.textContent = String(detail.message || "Graft needs you in this tab.").slice(0, 300);
  const actions = document.createElement("div");
  actions.className = "row";
  actions.append(
    makeButton("done", detail.confirm ?? "I'm done", finish),
    makeButton("cancel", "Skip", () => send("cancelled")),
  );
  row.append(text, field, actions);
  root.append(makeStyle(), row);
  (document.documentElement || document.body).append(host);
  place();
}

/** Runs in the tab's isolated world: drops the ask without touching anything else. */
function removeAsk(): void {
  const ask = document.getElementById("graft-agent-ask");
  if (!ask) return;
  ask.dispatchEvent(new Event("graft-ask-remove"));
  ask.remove();
}
