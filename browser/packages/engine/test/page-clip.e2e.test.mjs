// Real Chrome: icon and widget screenshots crop the element itself on a scrolled page, and taking
// them never moves the user's scroll position.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { browserSurfaceApi } from "../dist/code-api-surface.js";

const chromePath = process.env.CHROME_PATH ?? "";

const PAGE = `<!doctype html><body style="margin:0">
<div style="height:1500px;background:rgb(0,0,255)"></div>
<button aria-label="Close" style="width:40px;height:40px;border:0;padding:0;background:rgb(255,0,0)"><svg width="1" height="1"></svg></button>
<div style="height:1500px;background:rgb(0,255,0)"></div>`;

const source = (name) => {
  const start = browserSurfaceApi.indexOf(`function ${name}(`);
  return browserSurfaceApi.slice(start, browserSurfaceApi.indexOf("\n}\n", start) + 2);
};

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((done, fail) => (socket.once("open", done), socket.once("error", fail)));
  let id = 0;
  const waiting = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const send = (method, params = {}) =>
    new Promise((done) => {
      waiting.set(++id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => socket.close() };
}

test(
  "element screenshots crop the element on a scrolled page without scrolling it",
  { skip: !process.env.REQUIRE_E2E && !(chromePath && existsSync(chromePath)) },
  async () => {
    const profile = await mkdtemp(join(tmpdir(), "graft-page-clip-"));
    const chrome = spawn(
      chromePath,
      [
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "--headless=new",
        "--no-first-run",
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    try {
      const endpoint = await new Promise((done) => {
        let text = "";
        chrome.stderr.on("data", (chunk) => {
          text += chunk;
          const found = /ws:\/\/\S+/.exec(text);
          if (found) done(found[0]);
        });
      });
      const port = new URL(endpoint).port;
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = await cdp(targets.find((item) => item.type === "page").webSocketDebuggerUrl);
      await page.send("Page.enable");
      await page.send("Page.navigate", { url: "data:text/html," + encodeURIComponent(PAGE) });
      await new Promise((done) => setTimeout(done, 500));
      const value = async (expression, awaitPromise = false) =>
        (await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }))
          .result.result.value;
      await value("scrollTo(0, 1400)");
      const [box] = await value(`(${source("__iconBoxes")})(5, "button")`);
      assert.ok(box.box.y > 0 && box.box.y < 600, JSON.stringify(box));
      const pageClip = new Function(`${source("__pageClip")}; return __pageClip;`)();
      const color = async (clip) => {
        const shot = await page.send("Page.captureScreenshot", { format: "png", clip });
        return value(
          `new Promise(async (done) => { const img = new Image(); img.src = "data:image/png;base64,${shot.result.data}"; await img.decode(); const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height; const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0); done([...ctx.getImageData(img.width >> 1, img.height >> 1, 1, 1).data].slice(0, 3).join(",")); })`,
          true,
        );
      };
      assert.equal(await color(pageClip(box.box, box, 0)), "255,0,0");
      // The old viewport-only clip cropped somewhere else on a scrolled page.
      assert.notEqual(await color({ ...box.box, scale: 1 }), "255,0,0");
      assert.equal(await value("scrollY"), 1400);
      page.close();
    } finally {
      chrome.kill();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  },
);
