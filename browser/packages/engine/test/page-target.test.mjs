// The real sandbox source, through the same step check the extension host uses.
// browser.page(tabId).evaluate, openTab then page.read, and the observation after the cell
// must all carry a target key. pin and delta stay on that observation.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
  url: "https://pixelscan.net/",
  title: "Pixelscan",
  status: "complete",
  active: true,
  pinned: false,
  groupId: -1,
  documentEpoch: 1,
  mine: true,
  label: "p1",
};

const sandbox = readFileSync(new URL("../src/code-sandbox.ts", import.meta.url), "utf8");

function distBase() {
  if (!process.env.PAGE_TARGET_DIST) return new URL("../dist/", import.meta.url);
  const url = pathToFileURL(process.env.PAGE_TARGET_DIST);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

async function sandboxSource() {
  const from = new Map();
  for (const match of sandbox.matchAll(/import \{([^}]+)\} from "\.\/([\w-]+)\.js";/g)) {
    for (const name of match[1].split(",").map((part) => part.trim()))
      if (name) from.set(name, match[2]);
  }
  const list = /evaluate\(\s*\[([\s\S]*?)\]\.join/.exec(sandbox);
  assert.ok(list, "code-sandbox.ts evaluates a joined list of runtime parts");
  const names = list[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const base = distBase();
  const parts = [];
  for (const name of names) {
    const file = from.get(name);
    assert.ok(file, `${name} is imported from a local module`);
    const module = await import(new URL(`${file}.js`, base));
    assert.equal(typeof module[name], "string", `${name} is runtime source`);
    parts.push(module[name]);
  }
  return parts.join("\n");
}

function issues(error) {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ` : "") + issue.message)
    .join("; ");
}

function evaluateValue(expression) {
  const source = String(expression);
  if (source.includes("marker-eval")) return "marker-eval";
  if (source.includes("__pageChallenge")) return [];
  if (source.includes("__listStep")) return { selector: "li", items: [], top: 0, moved: false };
  if (source.includes("__scrollerStep")) return source.includes('"index":-1') ? [] : null;
  if (source.includes("__expandRead")) return { clicked: [], skipped: [] };
  if (source.includes("__waitRead")) return { settled: true };
  if (source.includes("__readMarkdown")) return { markdown: "hello", notes: [] };
  if (source.includes("__readPageData") || source.includes("__readMetadata")) return { notes: [] };
  if (source.includes("location.href")) return "https://pixelscan.net/";
  if (source.includes("document.title")) return "Pixelscan";
  if (source.includes("shadowRoot")) return [];
  if (source.includes("__pageSelection") || source.includes("getSelection")) return "";
  if (source.includes("innerText")) return { url: "https://pixelscan.net/", text: "hello" };
  return null;
}

function reply(request) {
  if (request.browserInfo) return { clientInstanceIds: [KEY.clientInstanceId] };
  if (request.op === "listTabs") return { kind: "tabs", focusedWindowId: 1, tabs: [TAB] };
  if (request.op === "openTab") return { kind: "tab", tab: TAB, navigation: "ok" };
  if (request.op === "observe") {
    return {
      kind: "semantic",
      target: request.target,
      url: TAB.url,
      title: TAB.title,
      nodes: [],
      documentEpoch: 1,
      snapshotId: "snap-1",
    };
  }
  if (request.op === "evaluate") {
    const value = evaluateValue(request.expression);
    const changed = String(request.expression).includes("marker-eval") ? true : false;
    return { kind: "evaluate", data: { value, changed } };
  }
  if (request.op === "frames") return { data: [] };
  if (request.op === "cdp") {
    if (request.method === "Page.getFrameTree")
      return { data: { value: { frameTree: { frame: { id: "F1" } } } } };
    if (request.method === "Page.createIsolatedWorld")
      return { data: { value: { executionContextId: 1 } } };
    return { data: { value: { result: { value: "" } } } };
  }
  if (request.op === "session") return { data: { label: request.label, tab: TAB } };
  if (request.network === "take") return { log: { entries: [] } };
  if (request.network === "failures") return [];
  if (request.siteSkill === "list") return [];
  return {};
}

async function realm(source) {
  const steps = [];
  const logs = [];
  const context = {
    console: {
      log: (...args) => logs.push(args.map(String).join(" ")),
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
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
      const parsed = BrowserStepSchema.safeParse(request);
      if (!parsed.success) {
        throw new Error(
          `INVALID_INPUT: ${String(request.op)} ${issues(parsed.error)}`.slice(0, 400),
        );
      }
      steps.push(parsed.data);
    }
    return reply(request);
  };
  vm.runInContext(source, context, { filename: "sandbox.js" });
  return {
    steps,
    logs,
    async cell(code) {
      steps.length = 0;
      logs.length = 0;
      vm.runInContext("__beginCell()", context);
      let value;
      let error;
      try {
        value = await vm.runInContext(`(async () => {\n${code}\n})()`, context);
      } catch (caught) {
        error = caught;
      }
      try {
        await vm.runInContext("__finishCell()", context);
      } catch (caught) {
        logs.push(`Final observation unavailable: ${caught.message}`);
      }
      return { value, error, steps: [...steps], logs: [...logs] };
    },
  };
}

function targetOf(steps, op, includes) {
  return steps.find(
    (step) => step.op === op && (includes == null || JSON.stringify(step).includes(includes)),
  );
}

test("browser.page(number), openTab then read, and the post-cell observation take a target key", async () => {
  const box = await realm(await sandboxSource());

  const evaluated = await box.cell(
    "return await browser.page(562429985).evaluate(() => 'marker-eval');",
  );
  assert.equal(
    evaluated.error,
    undefined,
    `${evaluated.error?.message}\n${evaluated.logs.join("\n")}`,
  );
  assert.equal(evaluated.value, "marker-eval");
  const evaluate = targetOf(evaluated.steps, "evaluate", "marker-eval");
  assert.ok(evaluate, "evaluate ran");
  assert.deepEqual(evaluate.target, KEY);
  const observe = evaluated.steps.find((step) => step.op === "observe" && step.delta === true);
  assert.ok(
    observe,
    `post-cell observation missing\n${JSON.stringify(evaluated.steps.map((step) => step.op))}`,
  );
  assert.equal(observe.pin, true);
  assert.equal(observe.kind, "semantic");
  assert.deepEqual(observe.target, KEY);
  assert.equal(
    evaluated.logs.some((line) => /INVALID_INPUT|Final observation unavailable/.test(line)),
    false,
    evaluated.logs.join("\n"),
  );

  const read = await box.cell(
    "const p = await browser.openTab('https://pixelscan.net/');\nreturn await p.read();",
  );
  assert.equal(read.error, undefined, `${read.error?.message}\n${read.logs.join("\n")}`);
  assert.equal(read.value.title, "Pixelscan");
  assert.match(read.value.markdown, /hello/);
  assert.ok(read.steps.some((step) => step.op === "openTab"));
  for (const step of read.steps) {
    if (step.target) assert.deepEqual(step.target, KEY, step.op);
  }
  assert.equal(
    read.logs.some((line) => /INVALID_INPUT|Final observation unavailable/.test(line)),
    false,
    read.logs.join("\n"),
  );
});
