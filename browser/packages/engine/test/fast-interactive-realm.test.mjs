// Realm behaviour of the fast loop: parallel opens on one site get their own tabs, a plain
// "scroll down" act scrolls with no model call, glance is one page call with clean links, and a
// cell that only read never pays a final observation.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { BrowserStepSchema } from "@browserkit/protocol";

const KEY = {
  clientInstanceId: "11111111-1111-4111-8111-111111111111",
  browserRunId: "22222222-2222-4222-8222-222222222222",
  tabId: 562429985,
  tabIncarnation: "33333333-3333-4333-8333-333333333333",
};
const TAB = {
  target: KEY,
  windowId: 1,
  index: 0,
  url: "https://example.test/notes",
  title: "Notes",
  status: "complete",
  active: true,
  pinned: false,
  groupId: -1,
  documentEpoch: 1,
  mine: true,
  label: "p1",
};

const sandbox = readFileSync(new URL("../src/code-realm-source.ts", import.meta.url), "utf8");

async function sandboxSource() {
  const from = new Map();
  for (const match of sandbox.matchAll(/import \{([^}]+)\} from "\.\/([\w-]+)\.js";/g))
    for (const name of match[1].split(",").map((part) => part.trim()))
      if (name) from.set(name, match[2]);
  const list = /evaluate\(\s*\[([\s\S]*?)\]\.join/.exec(sandbox);
  assert.ok(list, "code-realm-source.ts evaluates a joined list of runtime parts");
  const parts = [];
  for (const name of list[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const file = from.get(name);
    const module = await import(new URL(`../dist/${file}.js`, import.meta.url));
    parts.push(module[name]);
  }
  return parts.join("\n");
}

function evaluateValue(expression) {
  const source = String(expression);
  // page.read reads the page in one call (__readBatch): expand, settle, Markdown, data, probe.
  if (source.includes("__readBatch"))
    return {
      expand: { clicked: [], skipped: [] },
      wait: { settled: true },
      markdown: { markdown: "The lamp is in stock", notes: [] },
      title: TAB.title,
      url: TAB.url,
      data: { notes: [] },
      probe: { rows: 0, scrollers: 0, frames: 0, bodyChars: 0, shadows: [] },
    };
  if (source.includes("__expandRead")) return { clicked: [], skipped: [] };
  if (source.includes("__waitRead")) return { settled: true };
  if (source.includes("__readMarkdown")) return { markdown: "The lamp is in stock", notes: [] };
  if (source.includes("__readPageData") || source.includes("__readMetadata"))
    return { notes: [], sources: {} };
  if (source.includes("__listStep")) return { selector: "li", items: [], top: 0, moved: false };
  if (source.includes("__scrollerStep")) return source.includes('"index":-1') ? [] : null;
  if (source.includes("maxControls"))
    return {
      url: TAB.url,
      title: TAB.title,
      text: "[Lamp](https://shop.test/p?id=1&utm_source=feed)",
      controls: [
        {
          role: "a",
          name: "Lamp",
          href: "https://shop.test/gp/slredirect/x?url=%2Fp%3Fid%3D1%26ref_%3Dad",
        },
      ],
      scroll: { y: 0, height: 2000, viewport: 800 },
    };
  if (source.includes("location.href")) return TAB.url;
  if (source.includes("document.title")) return TAB.title;
  if (source.includes("shadowRoot")) return [];
  return null;
}

const steps = [];
let nextTab = 100;
function reply(request) {
  if (request && typeof request.op === "string") steps.push(request);
  if (request.op === "openTab") {
    const tab = {
      ...TAB,
      target: { ...KEY, tabId: ++nextTab },
      url: request.url,
      label: undefined,
    };
    return { kind: "tab", tab, navigation: "ok" };
  }
  if (request.op === "listTabs") {
    const opened = steps.filter((step) => step.op === "openTab");
    const tabs = opened.map((step, index) => ({
      ...TAB,
      target: { ...KEY, tabId: 101 + index },
      url: step.url,
      label: undefined,
    }));
    return { kind: "tabs", focusedWindowId: 1, tabs };
  }
  if (request.op === "scroll") return { kind: "action", outcome: "scrolled", url: TAB.url };
  if (request.op === "evaluate" && String(request.expression).includes("__glanceSource"))
    return { kind: "evaluate", data: { value: null } };
  if (request.browserInfo) return { clientInstanceIds: [KEY.clientInstanceId] };
  if (request.op === "listTabs") return { kind: "tabs", focusedWindowId: 1, tabs: [TAB] };
  if (request.op === "openTab") return { kind: "tab", tab: TAB, navigation: "ok" };
  if (request.op === "observe")
    return { kind: "semantic", target: request.target, url: TAB.url, nodes: [], documentEpoch: 1 };
  if (request.op === "evaluate")
    return { kind: "evaluate", data: { value: evaluateValue(request.expression) } };
  if (request.op === "frames") return { data: [] };
  if (request.op === "cdp") return { data: { value: { frameTree: { frame: { id: "F1" } } } } };
  if (request.guard) return {};
  return {};
}

async function realm(source) {
  const context = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    performance,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  };
  vm.createContext(context);
  context.globalThis = context;
  context.window = context;
  context.__call = async (request) => {
    if (request && typeof request.op === "string") {
      if (request.internal === true) delete request.internal;
      const parsed = BrowserStepSchema.safeParse(request);
      if (!parsed.success) throw new Error(`INVALID_INPUT: ${request.op}`);
    }
    return reply(request);
  };
  vm.runInContext(source, context, { filename: "sandbox.js" });
  return async (code) => {
    vm.runInContext("__beginCell()", context);
    const value = await vm.runInContext(`(async () => {\n${code}\n})()`, context);
    await vm.runInContext("__finishCell()", context).catch(() => undefined);
    return value;
  };
}

test("parallel opens of two URLs on one site get two tabs", async () => {
  const cell = await realm(await sandboxSource());
  await cell("globalThis.first = await browser.openTab('https://shop.test/a');");
  const ids = await cell(
    "const [a, b] = await Promise.all([browser.openTab('https://shop.test/b'), browser.openTab('https://shop.test/c')]);\nreturn [a.id, b.id, first.id];",
  );
  assert.equal(new Set(ids).size, 3, JSON.stringify(ids));
  const again = await cell("return (await browser.openTab('https://shop.test/a')).reused;");
  assert.equal(again, true, "the exact URL reuses its tab");
});

test("a plain scroll instruction scrolls the window with no model call", async () => {
  const cell = await realm(await sandboxSource());
  steps.length = 0;
  const outcome = await cell(
    "const p = await browser.openTab('https://shop.test/feed');\nreturn await p.act('Scroll down the page');",
  );
  assert.equal(outcome.ok, true);
  assert.ok(steps.some((step) => step.op === "scroll" && step.direction === "down"));
});

test("glance answers with the screen and clean links", async () => {
  const cell = await realm(await sandboxSource());
  const glance = await cell(
    "const p = await browser.openTab('https://shop.test/list');\nreturn await p.glance();",
  );
  assert.equal(glance.text, "[Lamp](https://shop.test/p?id=1)");
  assert.equal(glance.controls[0].href, "https://shop.test/p?id=1");
});

test("a cell that only read pays no final observation", async () => {
  const cell = await realm(await sandboxSource());
  await cell("globalThis.p = await browser.openTab('https://shop.test/read');");
  steps.length = 0;
  await cell("await browser.tabs();\nawait p.glance();\nawait p.read();");
  assert.ok(!steps.some((step) => step.op === "observe"), JSON.stringify(steps.map((s) => s.op)));
});
