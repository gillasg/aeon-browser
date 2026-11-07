// The visible agent cursor and its caption, for the user watching the agent work. Purely
// cosmetic: every update is sent without awaiting, never fails or delays an action, ignores
// pointer input and stays out of the accessibility tree. Animation runs inside the page, so the
// agent moves on while the cursor is still gliding.
import { engineConfig } from "./engine-config.js";
import { browserSessionTabs } from "./native-browser-session.js";
import { onEngineInstall } from "./native-engine-install.js";
export interface CursorUpdate {
  x?: number;
  y?: number;
  /** Click: press the cursor down and ripple. */
  press?: boolean;
  /** I-beam over editable fields. */
  text?: boolean;
  /** Drag: draw a trail from here to x, y. */
  from?: { x: number; y: number };
  /** Caption pill shown beside the cursor. */
  caption?: string;
  /** Reveal the caption letter by letter (visible typing). */
  typing?: boolean;
  /** Skip if another caption appeared in the last moment (reads must not hide actions). */
  soft?: boolean;
  /** Dim the page around a target rectangle (viewport coordinates). */
  spotlight?: { x: number; y: number; width: number; height: number };
  hideSpotlight?: boolean;
  /** A label anchored to a target rectangle. */
  callout?: {
    x: number;
    y: number;
    width?: number;
    height?: number;
    label: string;
    detail?: string;
  };
  /** Show keys being pressed for a moment. */
  keys?: string[];
  /** Caption is an obvious action (click/type): hide it after ~2 s instead of keeping it. */
  transient?: boolean;
  /** Edge glow around a tab an agent drives. */
  glow?: boolean;
  /** The user has control: dim the glow and stop its pulse. */
  glowDim?: boolean;
  /** Create the overlay for the glow without showing the cursor yet. */
  glowOnly?: boolean;
  /** CSS colour for the glow (hex or rgb()). */
  glowColor?: string;
  /** Initial viewport position when the overlay is recreated after a navigation. */
  start?: { x: number; y: number };
  /** The agent waits for the user: amber cursor and spotlight, no glow, the message as caption. */
  needs?: string | null;
  /** The tab is being recorded with the cursor: show only the cursor, nothing else of ours. */
  clean?: boolean;
}

const OVERLAY = `(update) => {
  const make = (tag, attrs = {}, kids = [], ns) => {
    const node = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    node.append(...kids);
    return node;
  };
  const svg = (tag, attrs, kids) => make(tag, attrs, kids, "http://www.w3.org/2000/svg");
  const sheet = (text) => { const style = document.createElement("style"); style.textContent = text; return style; };
  const id = "aeon-agent-cursor";
  let host = document.getElementById(id);
  if (!host) {
    host = document.createElement("div");
    host.id = id;
    host.setAttribute("data-aeon-overlay", "");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict";
    const root = host.attachShadow({ mode: "closed" });
    // Built node by node, never from an HTML string: pages that enforce Trusted Types
    // (Google's, among others) refuse innerHTML, and the cursor and its asks would never draw.
    root.append(
      sheet(
      '.g{position:fixed;inset:0;border-radius:18px;pointer-events:none;opacity:0;transform:none;box-shadow:inset 0 0 0 1.5px rgba(139,147,167,.85),inset 0 0 22px rgba(139,147,167,.5),inset 0 0 80px rgba(139,147,167,.22);transition:opacity .3s ease;animation:edge 2.8s ease-in-out infinite}' +
      '.g.on{opacity:1}.g.user{animation:none;opacity:.35}@keyframes edge{50%{opacity:.7}}' +
      '.needs .g{opacity:0!important}.needs .p{background:#e08a00!important}.needs .s{border-color:rgba(224,138,0,.95)}' +
      '.needs .p{display:block;white-space:normal;width:300px;max-width:min(340px,80vw);padding:10px 10px 8px 12px;border-radius:14px;pointer-events:auto;line-height:17px}' +
      '.needs .p .sp,.needs .p > .tr,.needs .p > .stop{display:none}' +
      '.p .ask{display:flex;align-items:center;gap:6px;margin-top:8px}.p .ask input{flex:1;min-width:0;height:28px;border:0;border-radius:999px;padding:0 12px;background:rgba(255,255,255,.22);color:#fff;font:500 12.5px/16px system-ui,-apple-system,Segoe UI,sans-serif;outline:none}' +
      '.p .ask input::placeholder{color:rgba(255,255,255,.85)}.p .ask .done{border:0;border-radius:999px;padding:5px 13px;font:600 12px/16px system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;background:#fff;color:#7a4a00}' +
      '.clean .g,.clean .p,.clean .s,.clean .co,.clean .k,.clean svg.trail{display:none!important}' +
      '.c{position:absolute;left:0;top:0;will-change:transform;transition:opacity .18s ease}' +
      '.a,.t{position:absolute;left:-1px;top:-1px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));transition:transform 120ms ease,opacity 120ms ease}' +
      '.t{left:-6px;top:-11px;opacity:0}.c.text .a{opacity:0}.c.text .t{opacity:1}' +
      '.c.down .a,.c.down .t{transform:scale(.82)}' +
      '.c.idle .a{animation:b 2.4s ease-in-out infinite}@keyframes b{50%{transform:scale(1.06);opacity:.85}}' +
      'i{position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:50%;border:2px solid rgba(17,24,39,.55);background:rgba(255,255,255,.35);transform:scale(0);opacity:0}' +
      'i.on{animation:r 520ms cubic-bezier(.2,.7,.2,1)}@keyframes r{0%{transform:scale(.25);opacity:1}100%{transform:scale(1.6);opacity:0}}' +
      '.p{position:absolute;left:18px;top:20px;display:flex;align-items:center;gap:8px;max-width:360px;padding:5px 5px 5px 12px;border-radius:999px;background:rgba(17,24,39,.92);color:#fff;font:500 12.5px/17px system-ui,-apple-system,Segoe UI,sans-serif;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.25);opacity:0;transform:translateY(-3px);transition:opacity 160ms ease,transform 160ms ease}' +
      '.p.on{opacity:1;transform:none}.p.on .ic{pointer-events:auto}' +
      '.p .tx{overflow:hidden;text-overflow:ellipsis;min-width:0}.needs .p .tx{display:block;white-space:normal}' +
      '.p .sp{width:11px;height:11px;flex:none;border-radius:50%;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;animation:sp .8s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}' +
      '.p .ic{width:24px;height:24px;flex:none;border:0;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.12);color:#fff;font:600 11px/1 system-ui,sans-serif;cursor:pointer;padding:0}.p .ic:hover{background:rgba(255,255,255,.24)}' +
      'svg.trail{position:absolute;inset:0;width:100%;height:100%;overflow:visible}' +
              ''),
      make("div", { class: "w" }, [
        make("div", { class: "g" }),
        svg("svg", { class: "trail" }),
        make("div", { class: "c" }, [
          make("i"),
          // The cursor: a plain white pointer without a stem, the same one the summoned cursor shows.
          svg("svg", { class: "a", width: "18", height: "20", viewBox: "0 0 18 20" }, [
            svg("path", { d: "M1.5 1.5 L1.5 16.5 L13.5 9.5 Z", fill: "#fff", stroke: "#111", "stroke-width": "1.5", "stroke-linejoin": "round" }),
          ]),
          svg("svg", { class: "t", width: "12", height: "22", viewBox: "0 0 12 22" }, [
            svg("path", { d: "M2 1.5h8M2 20.5h8M6 1.5v19", stroke: "#111", "stroke-width": "2.2", "stroke-linecap": "round", fill: "none" }),
          ]),
          // The pill: what it is doing, then the transcript (in the side panel) and stop.
          make("div", { class: "p" }, [
            make("span", { class: "sp" }),
            make("span", { class: "tx" }),
            make("button", { class: "ic tr", title: "Open the transcript in the side panel", "aria-label": "Open the transcript" }, ["☰"]),
            make("button", { class: "ic stop", title: "Stop", "aria-label": "Stop" }, ["■"]),
          ]),
        ]),
      ]),
    );
    const wrap = root.querySelector(".w");
    wrap.append(
      sheet(
      '.s{position:fixed;left:0;top:0;border-radius:12px;border:2px solid rgba(99,102,241,.9);box-shadow:0 0 0 9999px rgba(15,23,42,.55);opacity:0;pointer-events:none;transition:left .25s ease,top .25s ease,width .25s ease,height .25s ease,opacity .2s ease}' +
      '.s.on{opacity:1}' +
      '.co{position:fixed;max-width:280px;padding:7px 10px;border-radius:10px;background:#111827;color:#fff;font:500 12px/16px system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3);opacity:0;transform:translateY(4px);transition:opacity .18s ease,transform .18s ease;pointer-events:none}' +
      '.co.on{opacity:1;transform:none}.co b{display:block;font-weight:600}.co span{display:block;opacity:.75;font-size:11px;margin-top:2px}' +
      '.k{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(6px);padding:6px 10px;border-radius:8px;background:rgba(17,24,39,.9);color:#fff;font:600 11px/14px system-ui;opacity:0;transition:opacity .18s ease,transform .18s ease;pointer-events:none}' +
      '.k.on{opacity:1;transform:translateX(-50%)}' +
              ''),
      make("div", { class: "s" }),
      make("div", { class: "co" }),
      make("div", { class: "k" }),
    );
    const state = host.__s = {
      root, wrap, cursor: root.querySelector(".c"), ripple: root.querySelector("i"),
      glow: root.querySelector(".g"), glowColor: "",
      pill: root.querySelector(".p"), text: root.querySelector(".p .tx"), trail: root.querySelector("svg.trail"),
      spotlight: root.querySelector(".s"), callout: root.querySelector(".co"), keys: root.querySelector(".k"),
      pageX: update.start ? update.start.x + scrollX : innerWidth / 2 + scrollX,
      pageY: update.start ? update.start.y + scrollY : innerHeight / 2 + scrollY,
      frame: 0, idle: 0, hide: 0, type: 0, cursorShown: false,
    };
    // Pinned to the page, not the viewport: when the page scrolls, the cursor scrolls with it.
    const place = () => { state.cursor.style.transform = "translate(" + (state.pageX - scrollX) + "px," + (state.pageY - scrollY) + "px)"; };
    state.place = place;
    // The transcript and stop buttons reach the extension's content script as page events (names
    // only, no data), which opens the side panel on this tab's chat or stops it. A page can send
    // them too; neither gives it anything (a transcript it cannot read, a stopped run).
    const tell = (name) => (event) => { event.stopPropagation(); event.preventDefault(); dispatchEvent(new Event(name)); };
    root.querySelector(".p > .tr").addEventListener("click", tell("aeon-cursor-transcript"));
    root.querySelector(".p > .stop").addEventListener("click", tell("aeon-cursor-stop"));
    // Hovering the pill keeps it up, so its buttons can be reached.
    state.pill.addEventListener("mouseenter", () => clearTimeout(state.hide));
    state.pill.addEventListener("mouseleave", () => { if (!state.wrap.classList.contains("needs")) state.hide = setTimeout(() => state.pill.classList.remove("on"), 2500); });
    addEventListener("scroll", place, { passive: true, capture: true });
    (document.documentElement || document.body).append(host);
    place();
  }
  const s = host.__s;
  if (update.glowColor && update.glowColor !== s.glowColor) {
    s.glowColor = update.glowColor;
    const rgb = toRgb(update.glowColor);
    if (rgb) s.glow.style.boxShadow = "inset 0 0 0 1.5px rgba(" + rgb + ",.85),inset 0 0 22px rgba(" + rgb + ",.5),inset 0 0 80px rgba(" + rgb + ",.22)";
    // A product colour also colours the caption, so cursor, caption and glow read as one thing.
    if (rgb && update.glowColor !== "#8b93a7") s.pill.style.background = "rgba(" + rgb + ",.95)";
  }
  if (update.glowOnly && !s.cursorShown) s.cursor.style.opacity = "0";
  if (update.x !== undefined || update.y !== undefined) {
    s.cursorShown = true;
    s.cursor.style.opacity = "1";
  }
  if (update.glow !== undefined) s.glow.classList.toggle("on", update.glow);
  if (update.glowDim !== undefined) s.glow.classList.toggle("user", update.glowDim);
  if (update.clean !== undefined) s.wrap.classList.toggle("clean", update.clean);
  if (update.needs !== undefined) {
    s.wrap.classList.toggle("needs", Boolean(update.needs));
    // An ask has buttons: it joins the accessibility tree while it is up.
    host.setAttribute("aria-hidden", update.needs ? "false" : "true");
    if (update.needs) { s.cursor.style.opacity = "1"; s.cursorShown = true; }
    else { s.spotlight.classList.remove("on"); s.pill.classList.remove("on"); }
  }
  s.cursor.classList.remove("idle");
  clearTimeout(s.idle);
  s.idle = setTimeout(() => s.cursor.classList.add("idle"), 2200);

  if (update.text !== undefined) s.cursor.classList.toggle("text", update.text);
  if (update.spotlight) {
    s.spotlight.style.left = update.spotlight.x + "px";
    s.spotlight.style.top = update.spotlight.y + "px";
    s.spotlight.style.width = update.spotlight.width + "px";
    s.spotlight.style.height = update.spotlight.height + "px";
    s.spotlight.classList.add("on");
  }
  if (update.hideSpotlight) s.spotlight.classList.remove("on");
  if (update.callout) {
    const c = update.callout;
    s.callout.textContent = "";
    const label = document.createElement("b");
    label.textContent = String(c.label || "").slice(0, 80);
    s.callout.append(label);
    if (c.detail) {
      const detail = document.createElement("span");
      detail.textContent = String(c.detail).slice(0, 120);
      s.callout.append(detail);
    }
    s.callout.style.left = Math.max(8, Math.min(innerWidth - 288, c.x)) + "px";
    s.callout.style.top = (c.y > 60 ? c.y - 44 : c.y + (c.height || 0) + 8) + "px";
    s.callout.classList.add("on");
  }
  if (update.keys && update.keys.length) {
    s.keys.textContent = "⌨ " + update.keys.slice(0, 4).join(" + ");
    s.keys.classList.add("on");
    clearTimeout(s.keysHide);
    s.keysHide = setTimeout(() => s.keys.classList.remove("on"), 2400);
  }
  if (typeof update.x === "number" && typeof update.y === "number") {
    // Glide along a gentle curve with ease-out, sized to the distance travelled.
    const fromX = s.pageX, fromY = s.pageY, toX = update.x + scrollX, toY = update.y + scrollY;
    const dx = toX - fromX, dy = toY - fromY, distance = Math.hypot(dx, dy);
    const duration = Math.min(520, 140 + distance * 0.45), bend = Math.min(80, distance * 0.18);
    const cx = fromX + dx / 2 - (dy / (distance || 1)) * bend, cy = fromY + dy / 2 + (dx / (distance || 1)) * bend;
    const start = performance.now();
    cancelAnimationFrame(s.frame);
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration), e = 1 - Math.pow(1 - t, 3);
      s.pageX = (1 - e) * (1 - e) * fromX + 2 * (1 - e) * e * cx + e * e * toX;
      s.pageY = (1 - e) * (1 - e) * fromY + 2 * (1 - e) * e * cy + e * e * toY;
      s.place();
      if (t < 1) s.frame = requestAnimationFrame(step);
      else if (update.press) press();
    };
    s.frame = requestAnimationFrame(step);
    if (update.from) trail(update.from.x, update.from.y, update.x, update.y);
  } else if (update.press) press();
  function press() {
    s.cursor.classList.add("down");
    setTimeout(() => s.cursor.classList.remove("down"), 140);
    s.ripple.classList.remove("on"); void s.ripple.offsetWidth; s.ripple.classList.add("on");
  }
  function trail(x1, y1, x2, y2) {
    s.trail.replaceChildren(svg("path", { d: "M" + x1 + " " + y1 + " L" + x2 + " " + y2, stroke: "rgba(99,102,241,.55)", "stroke-width": "3", "stroke-linecap": "round", "stroke-dasharray": "6 6", fill: "none" }));
    setTimeout(() => s.trail.replaceChildren(), 900);
  }
  if (update.needs) update.caption = update.needs;
  // While the agent waits for the user, its request stays the caption.
  else if (update.caption && s.wrap.classList.contains("needs")) update.caption = undefined;
  if (update.caption && !(update.soft && Date.now() - (s.captionAt || 0) < 1500)) {
    s.captionAt = Date.now();
    const text = String(update.caption).slice(0, update.needs ? 300 : 120);
    clearTimeout(s.hide); clearInterval(s.type);
    s.pill.classList.add("on");
    if (update.typing) {
      // Visual only: the real text is already in the field; the caption just reveals it.
      let shown = 0; const prefix = text.indexOf('"') + 1;
      s.text.textContent = text.slice(0, prefix);
      s.type = setInterval(() => {
        shown += Math.max(1, Math.ceil((text.length - prefix) / 12));
        s.text.textContent = text.slice(0, prefix + shown);
        if (prefix + shown >= text.length) clearInterval(s.type);
      }, 22);
    } else s.text.textContent = text;
    s.pill.querySelector(".ask")?.remove();
    // A hand-off asks in the pill itself: do it in the tab and press Done, or type the answer
    // instead (Enter or Done sends it). ✕ cancels; ☰ still opens the transcript.
    if (update.needs) {
      const ask = make("div", { class: "ask" });
      const field = make("input", { type: "text", placeholder: "Or type the answer here…", "aria-label": "Type the answer" });
      const answer = (value) => { globalThis[Symbol.for("aeon.handoff")] = value; s.wrap.classList.remove("needs"); s.pill.classList.remove("on"); };
      const finish = () => answer(field.value.trim() ? { answer: field.value.trim().slice(0, 2000) } : "done");
      field.addEventListener("keydown", (event) => { event.stopPropagation(); if (event.key === "Enter" && !event.isComposing) finish(); });
      for (const kind of ["keyup", "keypress", "input"]) field.addEventListener(kind, (event) => event.stopPropagation());
      const done = make("button", { class: "done" }, ["Done"]);
      done.onclick = (event) => { event.stopPropagation(); finish(); };
      const transcript = make("button", { class: "ic", title: "Open the transcript in the side panel", "aria-label": "Open the transcript" }, ["☰"]);
      transcript.onclick = (event) => { event.stopPropagation(); dispatchEvent(new Event("aeon-cursor-transcript")); };
      const cancel = make("button", { class: "ic", title: "Cancel", "aria-label": "Cancel" }, ["✕"]);
      cancel.onclick = (event) => { event.stopPropagation(); answer("cancelled"); };
      ask.append(field, done, transcript, cancel);
      s.pill.append(ask);
    }
    if (!update.needs) s.hide = setTimeout(() => s.pill.classList.remove("on"), update.transient ? 2000 : 6000);
  }
  function toRgb(color) {
    var text = String(color || "").trim();
    var hex = /^#([0-9a-f]{6})$/i.exec(text);
    if (hex) {
      var n = parseInt(hex[1], 16);
      return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
    }
    if (text.indexOf("rgb") !== 0) return "";
    var parts = text.slice(text.indexOf("(") + 1, text.lastIndexOf(")")).split(",");
    return parts.length >= 3 ? parts.slice(0, 3).map(function (part) { return String(Number(part)).trim(); }).join(",") : "";
  }
}`;

export function showAgentCursor(
  debuggee: chrome.debugger.Debuggee,
  x: number,
  y: number,
  press = false,
  extra: Omit<CursorUpdate, "x" | "y" | "press"> = {},
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const tabId = debuggee.tabId;
  const prior = tabId === undefined ? undefined : lastPositions.get(tabId);
  updateAgentCursor(debuggee, {
    ...extra,
    ...(prior && extra.start === undefined ? { start: prior } : {}),
    x: Math.round(x),
    y: Math.round(y),
    press,
  });
  if (tabId !== undefined) lastPositions.set(tabId, { x: Math.round(x), y: Math.round(y) });
}
const lastPositions = new Map<number, { x: number; y: number }>();
onEngineInstall(() => {
  chrome.tabs.onRemoved.addListener((tabId) => lastPositions.delete(tabId));
});

/** A caption without moving the cursor, e.g. while reading or navigating. */
export function showAgentCaption(debuggee: chrome.debugger.Debuggee, caption: string): void {
  updateAgentCursor(debuggee, { caption, soft: true });
}

// Tabs being recorded on video: nothing of ours is drawn, or only the cursor when asked for.
const recording = new Map<number, { cursor: boolean; pill?: boolean }>();
/** cursor: Aeon's cursor shows in the recording; pill: its pill, callouts and keys too (no glow). */
export function setTabRecording(
  tabId: number,
  state: { cursor: boolean; pill?: boolean } | undefined,
): void {
  if (state) recording.set(tabId, state);
  else recording.delete(tabId);
  if (state && !state.cursor) void removeAgentCursor(tabId);
  if (state?.cursor) updateAgentCursor({ tabId }, { glow: false });
}
export function tabRecording(tabId: number): { cursor: boolean; pill?: boolean } | undefined {
  return recording.get(tabId);
}

/** The toolbar dot on a tab an agent drives: the product colour, amber while it needs the user.
 * Extensions cannot mark the tab itself, so the dot sits on the toolbar icon of that tab. */
export async function showAgentBadge(tabId: number, needs = false): Promise<void> {
  const glow = await engineConfig.agentGlowColor().catch(() => NEUTRAL_GLOW);
  const color = needs ? "#e08a00" : glow === NEUTRAL_GLOW ? "#4f46e5" : glow;
  await chrome.action.setBadgeText({ tabId, text: " " }).catch(() => undefined);
  await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => undefined);
}
const NEUTRAL_GLOW = "#8b93a7";

/**
 * Page code that draws a hand-off's ask (amber cursor, pill with Done and Cancel). Run by the
 * hand-off itself, so an ask shows even with the cursor setting off or no debugger attached.
 */
export function agentNeedsExpression(
  message: string,
  spotlight?: { x: number; y: number; width: number; height: number },
): string {
  const point = spotlight
    ? {
        x: Math.round(spotlight.x + spotlight.width / 2),
        y: Math.round(spotlight.y + spotlight.height / 2),
      }
    : {};
  return `(${OVERLAY})(${JSON.stringify({ needs: message, glow: false, ...(spotlight ? { spotlight, ...point } : {}) })})`;
}

/** The agent waits for the user: the cursor turns amber, points (spotlight) and says why. */
export function showAgentNeeds(
  tabId: number,
  message: string | null,
  spotlight?: { x: number; y: number; width: number; height: number },
): void {
  const point = spotlight
    ? {
        x: Math.round(spotlight.x + spotlight.width / 2),
        y: Math.round(spotlight.y + spotlight.height / 2),
      }
    : undefined;
  void showAgentBadge(tabId, message !== null);
  updateAgentCursor(
    { tabId },
    {
      needs: message,
      ...(message !== null ? { glow: false } : { glow: true, hideSpotlight: true }),
      ...(spotlight && message !== null ? { spotlight, ...point } : {}),
    },
  );
}

/** The edge glow around a tab an agent drives; dimmed while the user has control. */
export async function showAgentGlow(tabId: number, dim = false): Promise<void> {
  if (!(await engineConfig.agentGlow().catch(() => true))) return;
  const glowColor = await engineConfig.agentGlowColor().catch(() => "#8b93a7");
  updateAgentCursor({ tabId }, { glow: true, glowDim: dim, glowOnly: true, glowColor });
}

export function dimAgentGlow(tabId: number, dim: boolean): void {
  updateAgentCursor({ tabId }, { glowDim: dim });
}

export function hideAgentGlow(tabId: number): void {
  updateAgentCursor({ tabId }, { glow: false });
}

/** Dim the page around a target, e.g. for a write confirmation or a hand-off. */
export function showAgentSpotlight(
  debuggee: chrome.debugger.Debuggee,
  rect: { x: number; y: number; width: number; height: number },
): void {
  updateAgentCursor(debuggee, { spotlight: rect });
}

export function hideAgentSpotlight(debuggee: chrome.debugger.Debuggee): void {
  updateAgentCursor(debuggee, { hideSpotlight: true });
}

/** A label anchored to a target, with an optional second line. */
export function showAgentCallout(
  debuggee: chrome.debugger.Debuggee,
  rect: { x: number; y: number; width?: number; height?: number },
  label: string,
  detail?: string,
): void {
  updateAgentCursor(debuggee, {
    callout: { ...rect, label, ...(detail !== undefined ? { detail } : {}) },
  });
}

/** Show the keys being pressed for a moment. */
export function showAgentKeys(debuggee: chrome.debugger.Debuggee, keys: string[]): void {
  updateAgentCursor(debuggee, { keys });
}

function updateAgentCursor(debuggee: chrome.debugger.Debuggee, update: CursorUpdate): void {
  const recorded = debuggee.tabId === undefined ? undefined : recording.get(debuggee.tabId);
  if (recorded && !recorded.cursor) return;
  if (recorded)
    update = recorded.pill ? { ...update, glow: false } : { ...update, clean: true, glow: false };
  void engineConfig
    .hideAgentCursor()
    .catch(() => false)
    .then((hidden) =>
      hidden
        ? undefined
        : chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
            expression: `(${OVERLAY})(${JSON.stringify(update)})`,
            silent: true,
          }),
    )
    .catch(() => undefined);
}

/** Fade out and remove the cursor in a session's tabs (all tabs without a session), e.g. once
 * the agent's turn is over. */
export async function clearAgentCursors(chatId?: string): Promise<void> {
  await Promise.all(browserSessionTabs(chatId).map(removeAgentCursor));
}
export async function removeAgentCursor(tabId: number): Promise<void> {
  // Cosmetic: never fails, also where scripting is unavailable.
  await Promise.resolve()
    .then(() =>
      chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: removeCursor }),
    )
    .catch(() => undefined);
}
function removeCursor(): void {
  const host = document.getElementById("aeon-agent-cursor");
  if (!host) return;
  host.style.transition = "opacity 300ms ease";
  host.style.opacity = "0";
  setTimeout(() => host.remove(), 320);
}
