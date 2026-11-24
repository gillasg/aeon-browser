// page.read() is an object. A check that treats it as text (txt.match) throws. .text is that
// text, and every other field stays.
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
  if (source.includes("__expandRead")) return { clicked: [], skipped: [] };
  if (source.includes("__waitRead")) return { settled: true };
  if (source.includes("__readMarkdown")) return { markdown: "The lamp is in stock", notes: [] };
  if (source.includes("__readPageData") || source.includes("__readMetadata"))
    return { notes: [], sources: {} };
  if (source.includes("__listStep")) return { selector: "li", items: [], top: 0, moved: false };
  if (source.includes("__scrollerStep")) return source.includes('"index":-1') ? [] : null;
  if (source.includes("location.href")) return TAB.url;
  if (source.includes("document.title")) return TAB.title;
  if (source.includes("shadowRoot")) return [];
  return null;
}

function reply(request) {
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

test("page.read returns an object, text is the page text, and the other fields stay", async () => {
  const cell = await realm(await sandboxSource());
  const read = await cell(
    "const p = await browser.openTab('https://example.test/notes');\nreturn await p.read();",
  );
  assert.equal(typeof read, "object");
  assert.equal(typeof read.text, "string");
  assert.equal(read.text, read.markdown);
  assert.match(read.text, /lamp is in stock/);
  assert.equal(typeof read.url, "string");
  assert.equal(typeof read.title, "string");
  assert.ok("data" in read);
  assert.ok("list" in read);
  assert.equal(typeof read.markdown, "string");
  const help = await cell("return help('reading')");
  assert.match(help, /returns an object/);
  assert.match(help, /\.text/);
  const docs = readFileSync(
    new URL("../../../docs/agent/sections/04-reading.md", import.meta.url),
    "utf8",
  );
  assert.match(docs, /returns an object/);
  assert.match(docs, /`text`/);
});
