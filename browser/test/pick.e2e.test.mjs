// Real Chrome: page.pick() with the user's real mouse and keyboard (CDP Input events, trusted by
// the page). Hovering outlines the element; clicking a link and a button picks them without
// following the link or submitting the form; a typed note is kept; Done returns selectors that
// match exactly the clicked elements and leaves nothing behind; Escape cancels cleanly.
// Run alone, from browser/: node --test test/pick.e2e.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  attachPage,
  missingChrome,
  readLine,
  sleep,
  startBridgeChrome,
  waitFor,
} from "./helpers/bridge-chrome.mjs";

const html = `<!doctype html><title>Pick</title><body style="margin:40px;font:16px sans-serif">
<a id="go" href="/elsewhere" style="display:inline-block;padding:10px">Go elsewhere</a>
<form action="/submitted" style="margin-top:40px"><button class="buy" style="padding:10px">Buy</button>
<button class="buy" data-mark="b2" style="padding:10px;margin-left:40px">Buy</button></form>
<p style="margin-top:40px">Price <span class="price">$10</span></p></body>`;

test(
  "page.pick: hover, two real clicks, a typed note, Done; then Escape cancels",
  { skip: missingChrome() },
  async () => {
    const hits = [];
    const site = createServer((request, response) => {
      hits.push(request.url);
      response.setHeader("content-type", "text/html");
      response.end(html);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${site.address().port}`;
    const chrome = await startBridgeChrome("pick");
    try {
      const picking = chrome.repl(pickCell(origin));
      const send = await attachPage(chrome.browser, `${origin}/`);
      // The agent's tab sits in the background; the user would have it in front and focused.
      await send("Page.bringToFront");
      await send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await waitFor(() => overlayUp(send), 60000);
      const link = await center(send, "#go");
      await mouse(send, "mouseMoved", link);
      await waitFor(async () => {
        const style = await shadowStyle(send, "box");
        assert.match(style, /display: block/);
        assert.match(style, new RegExp(`left: ${Math.round(link.left)}(\\.\\d+)?px`));
      });
      await click(send, link);
      await click(send, await center(send, '[data-mark="b2"]'));
      await sleep(150);
      for (const char of "submit button") await key(send, char);
      await enter(send);
      await click(send, await shadowCenter(send, "done"));
      const out = await picking;
      const text = `${out.stdout}\n${out.stderr}`;
      const result = readLine(text, "PICK");
      assert.ok(result, text);
      assert.equal(result.result.status, "done", text);
      assert.equal(result.result.picks.length, 2, text);
      const [first, second] = result.result.picks;
      assert.equal(first.selector, "#go");
      assert.deepEqual(
        [first.tag, first.role, first.name, first.note],
        ["a", "link", "Go elsewhere", ""],
      );
      assert.equal(second.tag, "button");
      assert.equal(second.note, "submit button");
      assert.ok(second.rect.width > 0 && second.rect.height > 0, text);
      assert.deepEqual(
        result.matches,
        [
          { count: 1, mark: "go" },
          { count: 1, mark: "b2" },
        ],
        text,
      );
      assert.equal(result.after.url, `${origin}/`, "the link was not followed");
      assert.equal(result.after.hosts, 0, "the overlay is gone");
      assert.equal(result.after.children, 3, "nothing was left in the page");
      assert.ok(!hits.some((url) => /elsewhere|submitted/.test(url)), hits.join(","));

      const cancelling = chrome.repl(cancelCell(origin));
      await waitFor(() => overlayUp(send), 60000);
      await click(send, link);
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      const cancelOut = await cancelling;
      const cancelled = readLine(`${cancelOut.stdout}`, "CANCEL");
      assert.ok(cancelled, `${cancelOut.stdout}\n${cancelOut.stderr}`);
      assert.equal(cancelled.result.status, "cancelled");
      assert.deepEqual(cancelled.result.picks, []);
      assert.equal(cancelled.hosts, 0);
      assert.ok(!hits.some((url) => /elsewhere|submitted/.test(url)), hits.join(","));
    } finally {
      await chrome.stop();
      site.close();
    }
  },
  240000,
);

const AFTER = `() => ({url: location.href, children: document.body.children.length,
  hosts: [...document.body.children].filter((e) => getComputedStyle(e).zIndex === '2147483647').length})`;

function pickCell(origin) {
  return `const page = await browser.openTab(${JSON.stringify(`${origin}/`)}, {space: 'tabs'});
const result = await page.pick({prompt: 'Pick the link and the second Buy button', timeoutMs: 90000});
const after = await page.evaluate(${AFTER});
const matches = await page.evaluate((selectors) => selectors.map((s) => { const f = document.querySelectorAll(s); return {count: f.length, mark: f[0] && (f[0].dataset.mark || f[0].id)}; }), result.picks.map((p) => p.selector));
console.log('PICK ' + JSON.stringify({result, after, matches}));`;
}

function cancelCell(origin) {
  return `const page = await browser.openTab(${JSON.stringify(`${origin}/`)}, {space: 'tabs'});
const result = await page.pick({timeoutMs: 90000});
const after = await page.evaluate(${AFTER});
console.log('CANCEL ' + JSON.stringify({result, hosts: after.hosts}));`;
}

async function overlayUp(send) {
  const { result } = await send("Runtime.evaluate", {
    expression: `[...document.body.children].some((e) => getComputedStyle(e).zIndex === '2147483647')`,
    returnByValue: true,
  });
  if (result.value !== true) throw new Error("no overlay yet");
}

async function center(send, selector) {
  const { result } = await send("Runtime.evaluate", {
    expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left}; })()`,
    returnByValue: true,
  });
  return result.value;
}

// The overlay is in a closed shadow root: only DevTools (pierce) can see inside it.
async function shadowNode(send, className) {
  const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
  const walk = (node) => {
    const attributes = node.attributes ?? [];
    for (let i = 0; i < attributes.length; i += 2)
      if (attributes[i] === "class" && attributes[i + 1] === className) return node;
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  const found = walk(root);
  if (!found) throw new Error(`no .${className} in the overlay`);
  return found;
}

async function shadowStyle(send, className) {
  const node = await shadowNode(send, className);
  const attributes = node.attributes ?? [];
  const at = attributes.indexOf("style");
  return at >= 0 ? attributes[at + 1] : "";
}

async function shadowCenter(send, className) {
  const node = await shadowNode(send, className);
  const { model } = await send("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
  const [x1, y1, , , x2, y2] = model.content;
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

function mouse(send, type, point) {
  return send("Input.dispatchMouseEvent", {
    type,
    x: point.x,
    y: point.y,
    button: type === "mouseMoved" ? "none" : "left",
    clickCount: type === "mouseMoved" ? 0 : 1,
  });
}

async function click(send, point) {
  await mouse(send, "mouseMoved", point);
  await mouse(send, "mousePressed", point);
  await mouse(send, "mouseReleased", point);
  await sleep(100);
}

async function key(send, char) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
}

async function enter(send) {
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
