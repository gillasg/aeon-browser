// Page-world painter for the one cursor. The engine evaluates this source through CDP, and the
// Aeon extension installs the same source, so both worlds share one host and one glide.
import { CURSOR_MARK, CURSOR_TOKEN_CSS, glideDuration, glidePoint } from "./cursor-mark.js";

/** What the painter is showing right now. Nothing shown means the host leaves the page. */
export interface CursorPaint {
  needs?: boolean;
  glow?: boolean;
  pill?: boolean;
  spotlight?: boolean;
  callout?: boolean;
  keys?: boolean;
  cursorShown?: boolean;
  opacity?: string;
}

/**
 * Whether anything of the cursor's is on screen. The host (and the extension's buttons beside it)
 * is removed from the page once this is false and stays so: a page with nothing happening on it
 * carries no DOM of ours.
 */
export function cursorVisible(paint: CursorPaint): boolean {
  if (paint.needs === true) return true;
  if (paint.glow || paint.pill || paint.spotlight || paint.callout || paint.keys) return true;
  return paint.cursorShown === true && paint.opacity !== "0";
}

const PAGE_STYLE = [
  ".g{position:fixed;inset:0;border-radius:var(--aeon-r-18);pointer-events:none;opacity:0;transform:none;",
  "box-shadow:inset 0 0 0 1.5px var(--aeon-island-glow-line),inset 0 0 22px var(--aeon-island-glow-mid),inset 0 0 80px var(--aeon-island-glow-soft);",
  "transition:opacity .3s ease;animation:edge 2.8s ease-in-out infinite}",
  ".g.on{opacity:1}.g.user{animation:none;opacity:.35}@keyframes edge{50%{opacity:.7}}",
  ".needs .g{opacity:0!important}.needs .p{background:var(--aeon-island-needs)!important}",
  ".needs .s{border-color:var(--aeon-island-needs-line)}",
  ".needs .p{display:block;white-space:normal;width:300px;max-width:min(340px,80vw);padding:10px 10px 8px 12px;",
  "border-radius:var(--aeon-r-14);pointer-events:auto;line-height:17px}",
  ".needs .p .sp,.needs .p > .tr,.needs .p > .stop{display:none}",
  ".p .ask{display:flex;align-items:center;gap:6px;margin-top:8px}",
  ".p .ask input{flex:1;min-width:0;height:28px;border:0;border-radius:var(--aeon-r-full);padding:0 12px;",
  "background:var(--aeon-island-field);color:var(--aeon-island-ink);",
  "font:500 var(--aeon-fs-md)/16px system-ui,-apple-system,Segoe UI,sans-serif;outline:none}",
  ".p .ask input::placeholder{color:var(--aeon-island-ink-soft)}",
  ".p .ask .done{border:0;border-radius:var(--aeon-r-full);padding:5px 13px;",
  "font:600 var(--aeon-fs-sm)/16px system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;",
  "background:var(--aeon-island-ink);color:var(--aeon-island-needs-ink)}",
  ".clean .g,.clean .p,.clean .s,.clean .co,.clean .k,.clean svg.trail{display:none!important}",
  ".c{position:absolute;left:0;top:0;will-change:transform;transition:opacity .18s ease}",
  ".a,.t{position:absolute;left:-1px;top:-1px;filter:drop-shadow(0 1px 2px var(--aeon-cursor-shadow));",
  "transition:transform 120ms ease,opacity 120ms ease}",
  ".t{left:-6px;top:-11px;opacity:0}.c.text .a{opacity:0}.c.text .t{opacity:1}",
  ".c.down .a,.c.down .t{transform:scale(.82)}",
  ".c.idle .a{animation:b 2.4s ease-in-out infinite}@keyframes b{50%{transform:scale(1.06);opacity:.85}}",
  "i{position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:var(--aeon-r-half);",
  "border:2px solid var(--aeon-island-ripple);background:var(--aeon-island-ripple-fill);transform:scale(0);opacity:0}",
  "i.on{animation:r 520ms cubic-bezier(.2,.7,.2,1)}@keyframes r{0%{transform:scale(.25);opacity:1}100%{transform:scale(1.6);opacity:0}}",
  ".p{position:absolute;left:18px;top:20px;display:flex;align-items:center;gap:8px;max-width:360px;",
  "padding:5px 5px 5px 12px;border-radius:var(--aeon-r-full);background:var(--aeon-island-bg);",
  "color:var(--aeon-island-ink);font:500 var(--aeon-fs-md)/17px system-ui,-apple-system,Segoe UI,sans-serif;",
  "white-space:nowrap;box-shadow:0 6px 18px var(--aeon-island-shadow);opacity:0;transform:translateY(-3px);",
  "transition:opacity 160ms ease,transform 160ms ease}",
  ".p.on{opacity:1;transform:none}.p.on .ic{pointer-events:auto}.p.on .tr,.p.on .stop{pointer-events:none}",
  ".p .tx{overflow:hidden;text-overflow:ellipsis;min-width:0}.needs .p .tx{display:block;white-space:normal}",
  ".p .sp{width:11px;height:11px;flex:none;border-radius:var(--aeon-r-half);border:2px solid var(--aeon-island-spin);",
  "border-top-color:var(--aeon-island-ink);animation:sp .8s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}",
  ".p .ic{width:24px;height:24px;flex:none;border:0;border-radius:var(--aeon-r-half);display:grid;place-items:center;",
  "background:var(--aeon-island-line-strong);color:var(--aeon-island-ink);font:600 var(--aeon-fs-xs)/1 system-ui,sans-serif;",
  "cursor:pointer;padding:0}.p .ic:hover{background:var(--aeon-island-wash-24)}",
  "svg.trail{position:absolute;inset:0;width:100%;height:100%;overflow:visible}",
  ".s{position:fixed;left:0;top:0;border-radius:var(--aeon-r-12);border:2px solid var(--aeon-island-ring);",
  "box-shadow:0 0 0 9999px var(--aeon-island-spot);opacity:0;pointer-events:none;",
  "transition:left .25s ease,top .25s ease,width .25s ease,height .25s ease,opacity .2s ease}.s.on{opacity:1}",
  ".co{position:fixed;max-width:280px;padding:7px 10px;border-radius:var(--aeon-r-md);background:var(--aeon-island-callout);",
  "color:var(--aeon-island-ink);font:500 var(--aeon-fs-sm)/16px system-ui,-apple-system,Segoe UI,sans-serif;",
  "box-shadow:0 8px 24px var(--aeon-island-callout-shadow);opacity:0;transform:translateY(4px);",
  "transition:opacity .18s ease,transform .18s ease;pointer-events:none}",
  ".co.on{opacity:1;transform:none}.co b{display:block;font-weight:600}.co span{display:block;opacity:.75;font-size:var(--aeon-fs-xs);margin-top:2px}",
  ".k{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(6px);padding:6px 10px;",
  "border-radius:var(--aeon-r-8);background:var(--aeon-island-keys);color:var(--aeon-island-ink);",
  "font:600 var(--aeon-fs-xs)/14px system-ui;opacity:0;transition:opacity .18s ease,transform .18s ease;pointer-events:none}",
  ".k.on{opacity:1;transform:translateX(-50%)}",
].join("");

const PAGE_BODY = `
  var styleText = ${JSON.stringify(PAGE_STYLE)};
  var make = function (tag, attrs, kids, ns) {
    var node = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    var values = attrs || {};
    for (var name in values) if (Object.prototype.hasOwnProperty.call(values, name)) node.setAttribute(name, values[name]);
    if (kids) node.append.apply(node, kids);
    return node;
  };
  var svg = function (tag, attrs, kids) { return make(tag, attrs, kids, "http://www.w3.org/2000/svg"); };
  var sheet = function (text) { var style = document.createElement("style"); style.textContent = text; return style; };
  var id = "aeon-agent-cursor";
  var host = document.getElementById(id);
  if (!host) {
    host = document.createElement("div");
    host.id = id;
    host.setAttribute("data-aeon-overlay", "");
    host.setAttribute("aria-hidden", "true");
    host.dataset.aeonCursor = String(mark && mark.path || "");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict";
    var root = host.attachShadow({ mode: "closed" });
    var arrow = svg("svg", { class: "a", width: String(mark.width || 22), height: String(mark.height || 20), viewBox: String(mark.viewBox || "0 0 25 23") }, [
      svg("path", { d: String(mark.path || ""), fill: "var(--aeon-cursor)", stroke: "var(--aeon-cursor-stroke)", "stroke-width": "1.5", "stroke-linejoin": "round" })
    ]);
    var noseX = 1.2 / 25 * Number(mark.width || 22);
    var noseY = 1.2 / 23 * Number(mark.height || 20);
    arrow.style.left = (-noseX) + "px";
    arrow.style.top = (-noseY) + "px";
    root.append(sheet(tokenCss || ""), sheet(styleText), make("div", { class: "w" }, [
      make("div", { class: "g" }),
      svg("svg", { class: "trail" }),
      make("div", { class: "c" }, [
        make("i"),
        arrow,
        svg("svg", { class: "t", width: String(mark.ibeamWidth || 12), height: String(mark.ibeamHeight || 22), viewBox: String(mark.ibeamViewBox || "0 0 12 22") }, [
          svg("path", { d: String(mark.ibeam || ""), stroke: "var(--aeon-cursor-stroke)", "stroke-width": "2.2", "stroke-linecap": "round", fill: "none" })
        ]),
        make("div", { class: "p" }, [
          make("span", { class: "sp" }),
          make("span", { class: "tx" }),
          make("button", { class: "ic tr", title: "Open the transcript in the side panel", "aria-label": "Open the transcript" }, ["☰"]),
          make("button", { class: "ic stop", title: "Stop", "aria-label": "Stop" }, ["■"])
        ])
      ])
    ]));
    var wrap = root.querySelector(".w");
    wrap.append(make("div", { class: "s" }), make("div", { class: "co" }), make("div", { class: "k" }));
    var bornX = typeof update.x === "number" ? update.x + scrollX : (update.start ? update.start.x + scrollX : innerWidth / 2 + scrollX);
    var bornY = typeof update.y === "number" ? update.y + scrollY : (update.start ? update.start.y + scrollY : innerHeight / 2 + scrollY);
    var state = host.__s = {
      root: root, wrap: wrap, cursor: root.querySelector(".c"), ripple: root.querySelector("i"),
      glow: root.querySelector(".g"), glowColor: "", pill: root.querySelector(".p"), text: root.querySelector(".p .tx"),
      trail: root.querySelector("svg.trail"), spotlight: root.querySelector(".s"), callout: root.querySelector(".co"),
      keys: root.querySelector(".k"), pageX: bornX, pageY: bornY, frame: 0, idle: 0, hide: 0, type: 0, cursorShown: false, agent: false
    };
    state.place = function () {
      var x = state.pageX - scrollX, y = state.pageY - scrollY;
      state.cursor.style.transform = "translate(" + x + "px," + y + "px)";
      host.dataset.aeonPoint = JSON.stringify({ x: Math.round(x), y: Math.round(y) });
      state.publish();
    };
    state.publish = function () {
      var rect = function (node) {
        if (!node) return null;
        var box = node.getBoundingClientRect();
        if (box.width < 2 || box.height < 2 || box.width > 64 || box.height > 64) return null;
        return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
      };
      var first = function (selector) {
        if (!state.pill.classList.contains("on")) return null;
        var nodes = root.querySelectorAll(selector);
        for (var i = 0; i < nodes.length; i++) { var box = rect(nodes[i]); if (box) return box; }
        return null;
      };
      host.dataset.aeonControls = JSON.stringify({ tr: first(".tr"), stop: first(".stop") });
    };
    state.shown = function () {
      return cursorVisible({
        needs: state.wrap.classList.contains("needs"),
        glow: state.glow.classList.contains("on"),
        pill: state.pill.classList.contains("on"),
        spotlight: state.spotlight.classList.contains("on"),
        callout: state.callout.classList.contains("on"),
        keys: state.keys.classList.contains("on"),
        cursorShown: state.cursorShown,
        opacity: state.cursor.style.opacity
      });
    };
    state.restSoon = function () {
      clearTimeout(state.restTimer);
      state.restTimer = setTimeout(function () {
        if (state.shown()) return;
        state.restWatch.disconnect();
        cancelAnimationFrame(state.frame);
        clearTimeout(state.hide); clearTimeout(state.keysHide); clearInterval(state.type);
        host.remove();
      }, 1200);
    };
    state.restWatch = new MutationObserver(state.restSoon);
    state.restWatch.observe(state.wrap, { attributes: true, subtree: true, attributeFilter: ["class", "style"] });
    state.restSoon();
    state.pill.addEventListener("mouseenter", function () { clearTimeout(state.hide); state.publish(); });
    state.pill.addEventListener("mouseleave", function () {
      if (!state.wrap.classList.contains("needs")) state.hide = setTimeout(function () { state.pill.classList.remove("on"); state.publish(); }, 2500);
    });
    addEventListener("scroll", state.place, { passive: true, capture: true });
    new MutationObserver(function () { applySummon(host); }).observe(host, { attributes: true, attributeFilter: ["data-aeon-summon", "data-aeon-release"] });
    (document.documentElement || document.body).append(host);
    state.place();
  }
  var s = host.__s;
  if (update.glowColor && update.glowColor !== s.glowColor) {
    s.glowColor = update.glowColor;
    var rgb = toRgb(update.glowColor);
    if (rgb) s.glow.style.boxShadow = "inset 0 0 0 1.5px rgba(" + rgb + ",.85),inset 0 0 22px rgba(" + rgb + ",.5),inset 0 0 80px rgba(" + rgb + ",.22)";
    if (rgb && update.glowColor !== (mark && mark.neutralGlow)) s.pill.style.background = "rgba(" + rgb + ",.95)";
  }
  if (update.glowOnly && !s.cursorShown) s.cursor.style.opacity = "0";
  if (update.x !== undefined || update.y !== undefined) { s.cursorShown = true; s.cursor.style.opacity = "1"; }
  if (update.glow !== undefined) s.glow.classList.toggle("on", update.glow);
  if (update.glowDim !== undefined) s.glow.classList.toggle("user", update.glowDim);
  if (update.clean !== undefined) s.wrap.classList.toggle("clean", update.clean);
  if (update.needs !== undefined) {
    s.wrap.classList.toggle("needs", Boolean(update.needs));
    host.setAttribute("aria-hidden", update.needs ? "false" : "true");
    if (update.needs) { s.cursor.style.opacity = "1"; s.cursorShown = true; }
    else { s.spotlight.classList.remove("on"); s.pill.classList.remove("on"); }
  }
  s.cursor.classList.remove("idle");
  clearTimeout(s.idle);
  s.idle = setTimeout(function () { s.cursor.classList.add("idle"); }, 2200);
  if (update.text !== undefined) s.cursor.classList.toggle("text", update.text);
  if (update.spotlight) {
    s.spotlight.style.left = update.spotlight.x + "px";
    s.spotlight.style.top = update.spotlight.y + "px";
    s.spotlight.style.width = update.spotlight.width + "px";
    s.spotlight.style.height = update.spotlight.height + "px";
    s.spotlight.classList.add("on");
  }
  if (update.hideSpotlight) s.spotlight.classList.remove("on");
  if (update.callout) paintCallout(s, update.callout);
  if (update.keys && update.keys.length) {
    s.keys.textContent = "⌨ " + update.keys.slice(0, 4).join(" + ");
    s.keys.classList.add("on");
    clearTimeout(s.keysHide);
    s.keysHide = setTimeout(function () { s.keys.classList.remove("on"); }, 2400);
  }
  var summonIgnored = update.summon && s.agent;
  if (!summonIgnored && (update.summon || update.release)) s.agent = false;
  else if (!summonIgnored && typeof update.x === "number" && typeof update.y === "number") s.agent = true;
  if (!summonIgnored && typeof update.x === "number" && typeof update.y === "number") {
    var toX = update.x + scrollX, toY = update.y + scrollY;
    if (update.place) { cancelAnimationFrame(s.frame); s.pageX = toX; s.pageY = toY; s.place(); if (update.press) press(s); }
    else glideTo(s, toX, toY, Boolean(update.press));
    if (update.from) trail(s, update.from.x, update.from.y, update.x, update.y);
  } else if (update.press) press(s);
  if (update.summon && typeof update.x === "number") {
    host.setAttribute("data-aeon-summon", JSON.stringify({ x: update.x, y: update.y, place: Boolean(update.place), release: false }));
  }
  if (update.needs) update.caption = update.needs;
  else if (update.caption && s.wrap.classList.contains("needs")) update.caption = undefined;
  if (update.caption && !(update.soft && Date.now() - (s.captionAt || 0) < 1500)) paintCaption(s, update, make);
  if (s.publish) { s.publish(); requestAnimationFrame(function () { s.publish(); }); }
  function reduceMotion() { return matchMedia("(prefers-reduced-motion: reduce)").matches; }
  function glideTo(state, toX, toY, pressAfter) {
    var fromX = state.pageX, fromY = state.pageY, distance = Math.hypot(toX - fromX, toY - fromY);
    var duration = reduceMotion() ? 0 : glideDuration(distance);
    cancelAnimationFrame(state.frame);
    if (duration < 1 || distance < 1) {
      state.pageX = toX; state.pageY = toY; state.place();
      if (pressAfter) press(state);
      return;
    }
    var start = performance.now();
    var step = function (now) {
      var t = Math.min(1, (now - start) / duration);
      var next = glidePoint(fromX, fromY, toX, toY, t);
      state.pageX = next.x; state.pageY = next.y; state.place();
      if (t < 1) state.frame = requestAnimationFrame(step);
      else if (pressAfter) press(state);
    };
    state.frame = requestAnimationFrame(step);
  }
  function press(state) {
    state.cursor.classList.add("down");
    setTimeout(function () { state.cursor.classList.remove("down"); }, 140);
    state.ripple.classList.remove("on"); void state.ripple.offsetWidth; state.ripple.classList.add("on");
  }
  function trail(state, x1, y1, x2, y2) {
    state.trail.replaceChildren(svg("path", { d: "M" + x1 + " " + y1 + " L" + x2 + " " + y2, stroke: "var(--aeon-island-trail)", "stroke-width": "3", "stroke-linecap": "round", "stroke-dasharray": "6 6", fill: "none" }));
    setTimeout(function () { state.trail.replaceChildren(); }, 900);
  }
  function paintCallout(state, callout) {
    state.callout.textContent = "";
    var label = document.createElement("b");
    label.textContent = String(callout.label || "").slice(0, 80);
    state.callout.append(label);
    if (callout.detail) {
      var detail = document.createElement("span");
      detail.textContent = String(callout.detail).slice(0, 120);
      state.callout.append(detail);
    }
    state.callout.style.left = Math.max(8, Math.min(innerWidth - 288, callout.x)) + "px";
    state.callout.style.top = (callout.y > 60 ? callout.y - 44 : callout.y + (callout.height || 0) + 8) + "px";
    state.callout.classList.add("on");
  }
  function paintCaption(state, next, makeNode) {
    state.captionAt = Date.now();
    var text = String(next.caption).slice(0, next.needs ? 300 : 120);
    clearTimeout(state.hide); clearInterval(state.type);
    state.pill.classList.add("on");
    if (next.typing) {
      var shown = 0; var prefix = text.indexOf('"') + 1;
      state.text.textContent = text.slice(0, prefix);
      state.type = setInterval(function () {
        shown += Math.max(1, Math.ceil((text.length - prefix) / 12));
        state.text.textContent = text.slice(0, prefix + shown);
        if (prefix + shown >= text.length) clearInterval(state.type);
      }, 22);
    } else state.text.textContent = text;
    var old = state.pill.querySelector(".ask");
    if (old) old.remove();
    if (next.needs) paintAsk(state, makeNode);
    if (!next.needs) state.hide = setTimeout(function () { state.pill.classList.remove("on"); state.publish(); }, next.transient ? 2000 : 6000);
  }
  function paintAsk(state, makeNode) {
    var ask = makeNode("div", { class: "ask" });
    var field = makeNode("input", { type: "text", placeholder: "Or type the answer here…", "aria-label": "Type the answer" });
    var answer = function (value) { globalThis[Symbol.for("aeon.handoff")] = value; state.wrap.classList.remove("needs"); state.pill.classList.remove("on"); state.publish(); };
    var finish = function () { answer(field.value.trim() ? { answer: field.value.trim().slice(0, 2000) } : "done"); };
    field.addEventListener("keydown", function (event) { event.stopPropagation(); if (event.key === "Enter" && !event.isComposing) finish(); });
    ["keyup", "keypress", "input"].forEach(function (kind) { field.addEventListener(kind, function (event) { event.stopPropagation(); }); });
    var done = makeNode("button", { class: "done" }, ["Done"]);
    done.onclick = function (event) { event.stopPropagation(); finish(); };
    var transcript = makeNode("button", { class: "ic tr", title: "Open the transcript in the side panel", "aria-label": "Open the transcript" }, ["☰"]);
    transcript.onclick = function (event) { event.stopPropagation(); };
    var cancel = makeNode("button", { class: "ic", title: "Cancel", "aria-label": "Cancel" }, ["✕"]);
    cancel.onclick = function (event) { event.stopPropagation(); answer("cancelled"); };
    ask.append(field, done, transcript, cancel);
    state.pill.append(ask);
  }
  function applySummon(node) {
    var state = node.__s;
    if (!state) return;
    if (node.getAttribute("data-aeon-release") === "1") {
      node.removeAttribute("data-aeon-release");
      rest(state, node);
    }
    var data = null;
    try { data = JSON.parse(node.getAttribute("data-aeon-summon") || ""); } catch (ignore) { data = null; }
    if (!data || typeof data.x !== "number" || typeof data.y !== "number") return;
    if (data.release) state.agent = false;
    if (state.agent) return;
    var destX = data.x + scrollX, destY = data.y + scrollY;
    if (data.place) { cancelAnimationFrame(state.frame); state.pageX = destX; state.pageY = destY; state.place(); }
    else glideTo(state, destX, destY, false);
  }
  function rest(state, node) {
    state.agent = false;
    state.wrap.classList.remove("needs");
    state.wrap.classList.remove("clean");
    state.glow.classList.remove("on");
    state.pill.classList.remove("on");
    state.spotlight.classList.remove("on");
    state.callout.classList.remove("on");
    state.keys.classList.remove("on");
    node.setAttribute("aria-hidden", "true");
    state.publish();
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
`;

/** Source of the page function. Glide math is the one exported implementation, inlined by source. */
export function cursorFunctionSource(): string {
  return (
    "function (update, tokenCss, mark) {\n" +
    glidePoint.toString() +
    "\n" +
    glideDuration.toString() +
    "\n" +
    cursorVisible.toString() +
    "\n" +
    PAGE_BODY +
    "\n}"
  );
}

/** Expression the engine evaluates. The extension calls the same function with the same arguments. */
export function cursorExpression(update: object): string {
  return (
    "(() => { const apply = " +
    cursorFunctionSource() +
    "; apply(" +
    JSON.stringify(update) +
    ", " +
    JSON.stringify(CURSOR_TOKEN_CSS) +
    ", " +
    JSON.stringify(CURSOR_MARK) +
    "); })()"
  );
}
