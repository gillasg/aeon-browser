// The fast everyday loop: a hung cell never blocks the next one, a glance and a read show clean
// links, a read that spills to disk stays line-readable, and trace lines for reads and opened
// tabs say what happened instead of "unverifiable".
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserRealmServer } from "../dist/code-realm-server.js";
import { FINISH_CELL_MS, HUNG_CELL_GRACE_MS } from "../dist/code-realm.js";
import { cleanLinkUrl, cleanMarkdownLinks } from "../dist/code-api-glance.js";
import { stepEventFrom } from "../dist/evidence/step-record.js";
import { dropOwnOverlayNodes } from "../dist/observe/own-overlay.js";
import { nestedLabels } from "../dist/observe/nested-label.js";
import { createSemanticNodes } from "../dist/native-browser-observation.js";

function harness() {
  const server = new BrowserRealmServer();
  const waits = new Map();
  const socket = {
    readyState: 1,
    send(text) {
      const frame = JSON.parse(text);
      setImmediate(() => {
        if (frame.kind === "browser.realm.op.reply") return waits.get(frame.opId)?.(frame);
        if (frame.event.kind === "call") return; // the browser never answers
        server.handle(
          { kind: "browser.realm.event.reply", eventId: frame.eventId, value: { ok: true } },
          socket,
        );
      });
    },
  };
  let sequence = 0;
  const op = (body) =>
    new Promise((resolve) => {
      const opId = String(++sequence);
      waits.set(opId, resolve);
      server.handle({ kind: "browser.realm.op", opId, op: body }, socket);
    });
  return { server, op };
}

test("the after-cell budget is strict and short", () => {
  assert.ok(FINISH_CELL_MS <= 1800);
  assert.ok(HUNG_CELL_GRACE_MS <= 2000);
});

test("a timed-out cell stuck on a promise that never settles does not hold the next cell", async () => {
  const { server, op } = harness();
  const running = op({
    kind: "cell",
    cellId: "hung",
    chatId: "a",
    code: "globalThis.rows = [1, 2]; await new Promise(() => {})",
  });
  await new Promise((done) => setTimeout(done, 150));
  await op({ kind: "interrupt", chatId: "a", cellId: "hung" });
  const frame = await running;
  const reply = frame.value;
  assert.ok(reply, JSON.stringify(frame));
  assert.match(reply.error, /TIMEOUT: browser cell did not finish/);
  assert.deepEqual(reply.value, [1, 2]);
  const started = Date.now();
  const next = (await op({ kind: "cell", cellId: "next", chatId: "a", code: "rows.length + 1" }))
    .value;
  assert.equal(next.value, 3, "the realm and its variables survive");
  assert.ok(Date.now() - started < 3000, "the next cell starts at once");
  await server.close();
});

test("ad redirects and tracking parameters are cut from links", () => {
  const ad =
    "https://www.amazon.in/sspa/click?ie=UTF8&spc=" +
    "x".repeat(900) +
    "&url=%2FSony-WH-1000XM5%2Fdp%2FB09XS7JWHH%2Fref%3Dsr_1_1_sspa%3Fcrid%3DABC";
  const clean = cleanLinkUrl(ad);
  assert.ok(clean.length < 120, clean);
  assert.match(clean, /^https:\/\/www\.amazon\.in\/Sony-WH-1000XM5\/dp\/B09XS7JWHH/);
  assert.equal(
    cleanLinkUrl("https://shop.test/item?id=7&utm_source=x&utm_medium=y&gclid=z"),
    "https://shop.test/item?id=7",
  );
  assert.ok(cleanLinkUrl("https://shop.test/" + "a".repeat(400)).length <= 180);
  const md = cleanMarkdownLinks(`[Lamp](https://shop.test/p?id=1&utm_campaign=${"q".repeat(300)})`);
  assert.equal(md, "[Lamp](https://shop.test/p?id=1)");
});

test("reads and opened tabs are not traced as unverifiable", () => {
  const base = { cellId: "c1", chatId: "chat", index: 0 };
  const read = stepEventFrom({
    ...base,
    step: { op: "observe" },
    entry: { result: { kind: "semantic", url: "https://shop.test/" } },
  });
  assert.equal(read.effect, "confirmed");
  const opened = stepEventFrom({
    ...base,
    step: { op: "openTab", url: "https://shop.test/" },
    entry: {
      result: { kind: "tab", tab: { url: "https://shop.test/" }, url: "https://shop.test/" },
    },
  });
  assert.equal(opened.effect, "opened_tab");
  const failedOpen = stepEventFrom({
    ...base,
    step: { op: "openTab", url: "https://shop.test/" },
    entry: { result: { kind: "tab", tab: {}, navigation: "failed" } },
  });
  assert.equal(failedOpen.effect, undefined);
});

let seq = 0;
const node = (role, name, parentId, extra = {}) => ({
  nodeId: `n${++seq}`,
  backendDOMNodeId: 5000 + seq,
  role: { value: role },
  name: { value: name },
  ...(parentId ? { parentId } : {}),
  ...extra,
});

test("Graft's own pill controls never reach the page state", () => {
  const root = node("RootWebArea", "Shop");
  const pill = node("generic", "", root.nodeId);
  const transcript = node("button", "Open the transcript in the side panel", pill.nodeId);
  const stop = node("button", "Stop", pill.nodeId);
  const pageStop = node("button", "Stop", root.nodeId);
  const kept = dropOwnOverlayNodes([root, pill, transcript, stop, pageStop]);
  assert.ok(!kept.includes(transcript));
  assert.ok(!kept.includes(stop));
  assert.ok(kept.includes(pageStop), "a page's own Stop button stays");
});

test("a calendar day button shows the full date its child labels", () => {
  const root = node("RootWebArea", "Flights");
  const day = node("button", "4", root.nodeId);
  const label = node("generic", "Friday, December 4, 2026", day.nodeId);
  const option = node("option", "Delhi, India", root.nodeId);
  const labels = nestedLabels([root, day, label, option]);
  assert.equal(labels.get(day.nodeId), "Friday, December 4, 2026");
  const { nodes } = createSemanticNodes([root, day, label, option]);
  assert.ok(nodes.some((n) => n.role === "button" && n.name === "Friday, December 4, 2026"));
  assert.ok(nodes.some((n) => n.role === "option" && n.name === "Delhi, India"));
});
