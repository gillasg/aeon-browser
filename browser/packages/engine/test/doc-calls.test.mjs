// Every code sample the agent text shows must run as written in the real code API. This test
// extracts the fenced examples and the documented one-line calls from the agent text, runs each in
// the sandbox realm against a fake engine whose step handler checks every step with the real
// protocol schemas, and fails when a documented call sends a step the engine rejects. The
// browser.page(tabId) drift that failed a live chat was exactly this: a documented call that the
// step schema refused.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";
import { BrowserStepSchema } from "@browserkit/protocol";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const engine = join(here, "..");
const browserRoot = join(engine, "..", "..");
const repo = join(browserRoot, "..");

// The realm's globals (browser, page, bu, …): names the text uses without declaring them.
const TAB_ID = 562429985;
const API = [
  "browser",
  "page",
  "bu",
  "site",
  "siteMapper",
  "google",
  "tables",
  "skills",
  "artifact",
  "checkpoint",
  "help",
  "saveAbility",
  "showImage",
  "finish_from_js",
];
// Values the text leaves to the reader in a full example (guidance.md's `url`, the provider
// sample's prompt and conversation). A fenced example may use only these.
const STAND_INS = {
  url: "https://shop.example/",
  prompt: "Which of these two laptops?",
  conversation: "conversation-1",
  question: "What happens in this video?",
  schema: { type: "object", properties: {} },
};
const STAND_IN_SOURCE = Object.fromEntries(
  Object.entries(STAND_INS).map(([name, value]) => [name, JSON.stringify(value)]),
);

// A one-line call in the text writes its arguments as names (bu.click(id), page.hold(target,
// {ms})). The test binds each name to a plausible value, so the documented call runs as written.
// A call using a name outside this table is a signature, not an example, and is counted apart.
const PLACEHOLDERS = {
  account: `"me@example.com"`,
  action: `"click"`,
  ads: "true",
  arg: "({})",
  banners: "true",
  before: `"2026-11-01"`,
  by: `"site"`,
  cache: "true",
  complete: "true",
  concurrency: "4",
  conversation: `"conversation-1"`,
  css: `"main"`,
  csv: `"out.csv"`,
  cursor: "true",
  data: "({})",
  days: "7",
  db: `"db-1"`,
  depth: "2",
  description: `"a demo"`,
  done: "1",
  download: `"file.pdf"`,
  event: `"Page.loadEventFired"`,
  expression: `"1"`,
  fact: `{kind: "selector", key: "k", value: "v"}`,
  files: `["media/photo.png"]`,
  fn: "async () => {}",
  fonts: "true",
  grep: `"x"`,
  handler: "() => {}",
  headers: "({})",
  height: "800",
  id: "12",
  images: "true",
  inputs: "({})",
  instruction: `"find the price"`,
  items: `["https://shop.example/"]`,
  jobId: `"job-1"`,
  json: "({})",
  key: `"id"`,
  kind: `"selector"`,
  label: `"tabs"`,
  lat: "1",
  latency: "0",
  limit: "10",
  lng: "2",
  locale: `"en-US"`,
  match: `"shop"`,
  max: "3000",
  media: "true",
  message: `"Please finish the check"`,
  method: `"Page.reload"`,
  model: `"gpt"`,
  ms: "1500",
  name: `"Search"`,
  offline: "false",
  operation: `"search"`,
  options: "({})",
  origin: `"https://shop.example"`,
  outer: "true",
  params: "({})",
  path: `"media/photo.png"`,
  perSecond: "1",
  p: `browser.page("p1")`,
  prompt: `"Which of these two laptops?"`,
  props: `["color"]`,
  q: `"lamp"`,
  query: `"lamp"`,
  recording: "({})",
  referer: `"https://shop.example/"`,
  request: `""`,
  root: `"e12"`,
  schema: `{type: "object"}`,
  script: `"1"`,
  seconds: "1",
  selector: `"#confirm"`,
  send: `"hello"`,
  since: `"2026-01-01"`,
  site: `"shop.example"`,
  steps: `[{action: "read", target: {role: "heading"}}]`,
  store: `"store-1"`,
  tab: `browser.page("p1")`,
  tabId: String(TAB_ID),
  target: `browser.page("p1")`,
  tests: "[]",
  text: `"hello"`,
  textOrRegex: `"ready"`,
  threshold: "0.1",
  timeMs: "1000",
  timeoutMs: "1000",
  timezone: `"UTC"`,
  topic: `"reading"`,
  total: "2",
  trackers: "true",
  type: `"cookies"`,
  until: `"2026-11-01"`,
  upload: "1000",
  url: `"https://shop.example/"`,
  urlFilter: `"*ads*"`,
  urlPart: `"/api"`,
  urls: `["https://shop.example/"]`,
  value: `"lamp"`,
  variables: `{email: "me@example.com"}`,
  verify: "() => true",
  versionId: `"v1"`,
  via: `"api"`,
  waitMs: "10",
  ways: `["api"]`,
  width: "1280",
  withPage: "false",
  x: "100",
  y: "200",
  x1: "10",
  y1: "20",
  x2: "30",
  y2: "40",
};

const KEY = {
  clientInstanceId: "11111111-1111-4111-8111-111111111111",
  browserRunId: "22222222-2222-4222-8222-222222222222",
  tabId: TAB_ID,
  tabIncarnation: "33333333-3333-4333-8333-333333333333",
};
const TAB = {
  target: KEY,
  windowId: 1,
  index: 0,
  url: "https://shop.example/",
  title: "Shop",
  status: "complete",
  active: true,
  pinned: false,
  groupId: -1,
  documentEpoch: 1,
  mine: true,
  label: "p1",
};
const SNAPSHOT_ID = "44444444-4444-4444-8444-444444444444";
const NODES = [
  { ref: "e12", backendNodeId: 12, role: "button", name: "Search" },
  { ref: "e2", backendNodeId: 2, role: "textbox", name: "Search" },
  { ref: "e3", backendNodeId: 3, role: "link", name: "Continue" },
];

const sandbox = readFileSync(new URL("../src/code-sandbox.ts", import.meta.url), "utf8");

/** The runtime source exactly as the sandbox evaluates it (dist parts, joined). */
async function sandboxSource() {
  const from = new Map();
  for (const match of sandbox.matchAll(/import \{([^}]+)\} from "\.\/([\w-]+)\.js";/g))
    for (const name of match[1].split(",").map((part) => part.trim()))
      if (name) from.set(name, match[2]);
  const list = /evaluate\(\s*\[([\s\S]*?)\]\.join/.exec(sandbox);
  assert.ok(list, "code-sandbox.ts evaluates a joined list of runtime parts");
  const parts = [];
  for (const name of list[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const file = from.get(name);
    assert.ok(file, `${name} is imported from a local module`);
    const module = await import(new URL(`../dist/${file}.js`, import.meta.url));
    assert.equal(typeof module[name], "string", `${name} is runtime source`);
    parts.push(module[name]);
  }
  return parts.join("\n");
}

function read(path) {
  return readFileSync(path, "utf8");
}

/** The sources whose examples the agent reads, as repo-relative paths. */
function corpus() {
  const docs = join(browserRoot, "docs", "agent");
  const sections = join(docs, "sections");
  const parts = join(repo, "skills", "aeon", "parts");
  const packs = join(docs, "packs");
  const files = [
    { path: "browser/docs/agent/guidance.md", path: join(docs, "guidance.md") },
    { path: "browser/docs/agent/primer-browserkit.md", path: join(docs, "primer-browserkit.md") },
    {
      path: "packages/pi-adapter/guidance-extra.md",
      path: join(repo, "packages", "pi-adapter", "guidance-extra.md"),
    },
  ];
  for (const [prefix, folder] of [
    ["browser/docs/agent/sections", sections],
    ["skills/aeon/parts", parts],
    ["browser/docs/agent/packs", packs],
  ]) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)
      .filter((entry) => entry.endsWith(".md"))
      .sort())
      files.push({ path: `${prefix}/${name}`, path: join(folder, name) });
  }
  return files;
}

// A fence whose first line is a no-run marker is deliberately partial: skipped, with its reason.
const NO_RUN = /^\s*\/\/\s*no-run:\s*(.+)$/;

function fence(line) {
  return /^\s*```(.*)$/.exec(line);
}

/** Fenced examples, inline code spans, and the help topics (which also carry the packs). */
function examples() {
  return extract(corpus().map((file) => ({ path: file.path, text: read(file.path) })));
}

function extract(files) {
  const examples = [];
  const skipped = [];
  const nonJs = [];
  for (const file of files) {
    const text = file.text;
    let open;
    text.split("\n").forEach((line, index) => {
      const marker = fence(line);
      if (marker) {
        if (!open) {
          open = { language: marker[1].trim(), line: index + 1, body: [] };
          return;
        }
        const code = open.body.join("\n").trim();
        const language = open.language;
        const start = open.line;
        open = undefined;
        if (!["js", "javascript", "ts", ""].includes(language)) {
          nonJs.push({ file: file.path, line: start, language });
          return;
        }
        const noRun = NO_RUN.exec(code.split("\n")[0] || "");
        if (noRun) skipped.push({ file: file.path, line: start, code, reason: noRun[1] });
        else examples.push({ file: file.path, line: start, code, kind: "fence" });
        return;
      }
      if (open) {
        open.body.push(line);
        return;
      }
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        const code = match[1].trim();
        if (!code.includes("(")) continue;
        if (!API.some((name) => code.replace(/^await\s+/, "").startsWith(name))) continue;
        examples.push({ file: file.path, line: index + 1, code, kind: "call" });
      }
    });
    assert.equal(open, undefined, `${file.path} closes every code fence`);
  }
  return { examples, skipped, nonJs };
}

/** The help topics (base topics plus the generated packs), as text. */
async function helpCalls() {
  const { HELP_TOPICS } = await import("../dist/code-api-help.js");
  const calls = [];
  for (const [topic, text] of Object.entries(HELP_TOPICS))
    for (const code of scanCalls(text))
      calls.push({ file: `help:${topic}`, line: 0, code, kind: "call" });
  return calls;
}

// A balanced call expression that starts at a runtime global, in prose or in code.
function scanCalls(text) {
  const calls = [];
  const roots = new RegExp(`(?:await\\s+)?(?:${API.join("|")})\\b`, "g");
  let match;
  while ((match = roots.exec(text))) {
    let index = match.index + match[0].length;
    let depth = 0;
    let started = false;
    let quote;
    let escape = false;
    let end = -1;
    for (; index < text.length; index++) {
      const character = text[index];
      if (escape) {
        escape = false;
        continue;
      }
      if (quote) {
        if (character === "\\") escape = true;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        continue;
      }
      if (character === "(") {
        depth += 1;
        started = true;
        continue;
      }
      if (character === ")") {
        depth -= 1;
        if (started && depth === 0) {
          end = index + 1;
          break;
        }
        continue;
      }
      if (!started && !/[.\w$]/.test(character)) break;
    }
    if (end < 0) continue;
    const code = text.slice(match.index, end);
    if (parses(code)) calls.push(code);
    roots.lastIndex = end;
  }
  return calls;
}

function parses(code) {
  try {
    parse(code, { ecmaVersion: "latest", allowAwaitOutsideFunction: true });
    return true;
  } catch {
    return false;
  }
}

// A fence is a cell body (top-level return is allowed); a one-line call is an expression.
function treeOf(code, cell) {
  return parse(cell ? `async function __cell() {\n${code}\n}` : code, {
    ecmaVersion: "latest",
    allowAwaitOutsideFunction: true,
  });
}

/** Identifiers a snippet uses without declaring: the values it expects from the reader. */
function freeNames(code, kind) {
  let tree;
  try {
    tree = treeOf(code, kind === "fence");
  } catch {
    return ["<not a complete statement>"];
  }
  const declared = new Set();
  const used = new Set();
  const builtins = new Set([
    ...API,
    "console",
    "JSON",
    "Math",
    "Date",
    "URL",
    "URLSearchParams",
    "Promise",
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "RegExp",
    "Error",
    "TypeError",
    "undefined",
    "setTimeout",
    "clearTimeout",
    "fetch",
    "document",
    "window",
    "Map",
    "Set",
    "Symbol",
    "Intl",
    "isNaN",
    "parseInt",
    "parseFloat",
    "encodeURIComponent",
    "decodeURIComponent",
    "globalThis",
  ]);
  const declare = (pattern) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") declared.add(pattern.name);
    else if (pattern.type === "ObjectPattern")
      for (const property of pattern.properties)
        declare(property.value ?? property.argument ?? property);
    else if (pattern.type === "ArrayPattern") for (const item of pattern.elements) declare(item);
    else if (pattern.type === "AssignmentPattern") declare(pattern.left);
    else if (pattern.type === "RestElement") declare(pattern.argument);
  };
  const walk = (node, parent, key) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "Identifier") {
      const property =
        parent &&
        ((parent.type === "MemberExpression" && key === "property" && !parent.computed) ||
          (parent.type === "Property" && key === "key" && !parent.computed) ||
          (parent.type === "VariableDeclarator" && key === "id") ||
          ((parent.type === "FunctionDeclaration" ||
            parent.type === "FunctionExpression" ||
            parent.type === "ArrowFunctionExpression") &&
            (key === "id" || key === "params")) ||
          (parent.type === "CatchClause" && key === "param") ||
          parent.type === "LabeledStatement" ||
          parent.type === "BreakStatement" ||
          parent.type === "ContinueStatement");
      if (!property) used.add(node.name);
      return;
    }
    if (node.type === "VariableDeclarator") declare(node.id);
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    )
      for (const parameter of node.params) declare(parameter);
    if (node.type === "CatchClause") declare(node.param);
    for (const [name, value] of Object.entries(node)) {
      if (["start", "end", "loc", "range", "type"].includes(name)) continue;
      if (Array.isArray(value)) value.forEach((item) => walk(item, node, name));
      else if (value && typeof value === "object") walk(value, node, name);
    }
  };
  walk(tree, undefined, undefined);
  return [...used].filter((name) => !declared.has(name) && !builtins.has(name)).sort();
}

function issueText(error) {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ` : "") + issue.message)
    .join("; ");
}

/** A fake engine: every step is checked with the protocol schema before it is answered. */
function reply(request) {
  if (!request || typeof request !== "object") return {};
  if (request.browserInfo) return { clientInstanceIds: [KEY.clientInstanceId] };
  if (request.op === "listTabs") return { kind: "tabs", focusedWindowId: 1, tabs: [TAB] };
  if (request.op === "openTab")
    return { kind: "tab", tab: { ...TAB, url: String(request.url) }, navigation: "ok" };
  if (request.op === "attachTab") return { kind: "tab", tab: TAB, navigation: "ok" };
  if (request.op === "observe") {
    if (request.kind === "screenshot")
      return {
        kind: "screenshot",
        source: "website",
        trust: "untrusted",
        target: request.target,
        documentEpoch: 1,
        screenshotId: SNAPSHOT_ID,
        url: TAB.url,
        viewport: { width: 1280, height: 800 },
        capturedAt: Date.now(),
        mimeType: "image/jpeg",
        dataBase64: "/9j/4AAQSkZJRg==",
      };
    return {
      kind: "semantic",
      source: "website",
      trust: "untrusted",
      target: request.target,
      documentEpoch: 1,
      snapshotId: SNAPSHOT_ID,
      url: TAB.url,
      nodes: NODES,
      truncated: false,
    };
  }
  if (request.op === "evaluate")
    return { kind: "evaluate", data: { value: evaluateValue(request.expression) } };
  if (request.op === "session")
    return { data: { label: request.label || "p1", tab: TAB, spaces: [] } };
  if (request.op === "frames") return { data: [] };
  if (request.op === "cdp") return { data: { value: cdpValue(request.method) } };
  if (request.op === "downloads")
    return { data: { state: "complete", downloadId: 1, path: "file.pdf" } };
  if (request.op === "cookies") return { data: [] };
  if (request.op === "networkStore") return { data: [] };
  if (request.op === "diagnostics") return { data: { console: [] } };
  if (request.op === "console") return { data: { console: [] } };
  if (request.op === "readiness") return { data: { state: "ready" } };
  if (request.op === "control") return { data: { control: "agent" } };
  if (request.op === "settle") return { data: { settle: { why: "quiet" } } };
  if (request.op === "scheduler") return { data: { tabs: [], shared: null } };
  if (request.op === "popups") return { data: { popups: [] } };
  if (request.op === "stealth") return { data: {} };
  if (request.op === "siteScript") return { data: {} };
  if (request.op === "event") {
    if (request.action === "subscribe") return { data: { subscriptionId: SNAPSHOT_ID } };
    // A stream the fake never feeds ends at its first poll, as a disposed subscription would.
    if (request.action === "poll") throw new Error("subscription disposed");
    return { data: {} };
  }
  if (request.op === "dialog") return { data: { type: "confirm", message: "ok", accepted: true } };
  if (request.op === "upload")
    return {
      kind: "action",
      target: request.target,
      documentEpoch: 1,
      url: TAB.url,
      effect: "confirmed",
      evidence: "set",
    };
  if (request.op)
    return {
      kind: "action",
      target: request.target,
      documentEpoch: 1,
      url: TAB.url,
      effect: "confirmed",
      evidence: "read back",
      outcome: "changed",
    };
  return nonStep(request);
}

function nonStep(request) {
  if ("signIn" in request)
    return { signedIn: true, site: "shop.example", provider: "chrome", account: "me@example.com" };
  if ("fillCode" in request) return { filled: true, from: "gmail" };
  if ("fillProfile" in request) return { filled: [], missing: [], other: [] };
  if ("handoff" in request) return "done";
  if ("progress" in request) return {};
  if ("workspace" in request)
    return request.workspace === "read"
      ? { data: { text: "" } }
      : { data: { entries: [] }, path: "artifact.txt" };
  if ("takes" in request)
    return request.takes === "list" ? [] : { stopped: { bytes: 1, mimeType: "video/webm" } };
  if ("settings" in request) return {};
  if ("network" in request) {
    if (request.network === "list") return [];
    if (request.network === "waitFor") return { url: TAB.url, status: 200, headers: {}, body: "" };
    if (request.network === "get")
      return {
        id: "1",
        method: "GET",
        url: TAB.url,
        status: 200,
        requestHeaders: {},
        responseHeaders: {},
      };
    return [];
  }
  if ("abilityRun" in request) return { ok: true, result: {} };
  if ("abilityRemove" in request) return { removed: true };
  if ("abilityList" in request) return [];
  if ("siteMapper" in request) return request.siteMapper === "sites" ? [] : {};
  if ("siteCapabilities" in request)
    return { abilities: [], lookups: [], changes: [], operations: [], notes: [], webmcp: [] };
  if ("siteSkill" in request)
    return request.siteSkill === "get"
      ? { name: "helper", code: "", domains: [], description: "" }
      : [];
  if ("siteNotes" in request) return "";
  if ("job" in request) return { jobId: "job-1", status: "done", done: 1, total: 1, results: [] };
  if ("sweep" in request) return { jobId: "job-1" };
  if ("context" in request)
    return {
      activeTab: null,
      openTabs: [],
      recentSites: [],
      topSites: [],
      matches: { history: [], bookmarks: [] },
    };
  if ("history" in request) return request.history === "top" ? { scanned: 0, groups: [] } : [];
  if ("bookmarks" in request) return [];
  if ("identity" in request) return { accounts: [] };
  if ("downloads" in request) return [];
  if ("boosts" in request) return [];
  if ("rules" in request || "permission" in request || "quiet" in request || "learned" in request)
    return {};
  if ("fetch" in request) return { status: 200, text: "" };
  if ("extension" in request) return { reloading: true };
  if ("guard" in request) return {};
  if ("savedRead" in request) return {};
  if ("tabs" in request) return { closed: 0, remaining: 0 };
  if ("session" in request) return { closed: 0 };
  if ("windows" in request) return { windows: [] };
  if ("tabGroups" in request) return { enabled: true };
  return {};
}

function cdpValue(method) {
  if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F1" } } };
  if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
  if (method === "Page.printToPDF") return { data: "aGk=" };
  if (method === "Runtime.evaluate") return { result: { value: "" } };
  return {};
}

// What the page's own code answers, by what the runtime asked it. The runtime sends its helpers
// as their own source, so the expressions are recognisable.
function evaluateValue(expression) {
  const source = String(expression);
  if (source.includes("marker-eval")) return "marker-eval";
  if (source.includes("__pageChallenge")) return [];
  if (source.includes("__listStep")) return { selector: "li", items: [], top: 0, moved: false };
  if (source.includes("__scrollerStep")) return source.includes('"index":-1') ? [] : null;
  if (source.includes("__expandRead")) return { clicked: [], skipped: [] };
  if (source.includes("__waitRead")) return { settled: true };
  if (source.includes("__readMarkdown")) return { markdown: "hello", notes: [] };
  if (source.includes("__readPageData") || source.includes("__readMetadata"))
    return { notes: [], sources: {}, urlParams: [] };
  if (source.includes("__pageFunctions")) return {};
  if (source.includes("location.href")) return TAB.url;
  if (source.includes("document.title")) return TAB.title;
  if (source.includes("shadowRoot")) return [];
  if (source.includes("__pageSelection") || source.includes("getSelection")) return "";
  if (source.includes("innerText")) return { url: TAB.url, text: "hello" };
  return null;
}

/** One fresh realm per example, started the way a cell starts: a tab already attached. */
async function realm(source) {
  const steps = [];
  const requests = [];
  const rejected = [];
  const logs = [];
  const timers = new Set();
  // A contract test, not a timing test: waits are compressed so a recorded example that sleeps
  // (page.recordMedia's 20 s) still runs its calls. Every timer is dropped when the example ends.
  const later =
    (repeat) =>
    (fn, ms, ...args) => {
      const id = (repeat ? setInterval : setTimeout)(
        () => {
          if (!repeat) timers.delete(id);
          fn(...args);
        },
        Math.min(Number(ms) || 0, 5),
      );
      timers.add(id);
      return id;
    };
  const stop = (id) => {
    timers.delete(id);
    clearTimeout(id);
    clearInterval(id);
  };
  const context = {
    console: {
      log: (...values) => logs.push(values.map(String).join(" ")),
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    setTimeout: later(false),
    clearTimeout: stop,
    setInterval: later(true),
    clearInterval: stop,
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
    requests.push(request);
    if (request && typeof request.op === "string") {
      const parsed = BrowserStepSchema.safeParse(request);
      if (!parsed.success) {
        const message = `INVALID_INPUT: ${request.op} ${issueText(parsed.error)}`;
        rejected.push({ request, message });
        throw new Error(message);
      }
      steps.push(parsed.data);
    }
    return reply(request);
  };
  vm.runInContext(source, context, { filename: "sandbox.js" });
  // The clock runs 1000× so a documented wait (page.waitForResponse's 50 s) ends in the test
  // instead of stalling it; calls and steps are identical, only the deadline arrives sooner.
  vm.runInContext(
    "(() => { const real = Date.now.bind(Date), start = real(); Date.now = () => start + (real() - start) * 999; })()",
    context,
  );
  return {
    steps,
    requests,
    rejected,
    logs,
    async cell(code, options = {}) {
      steps.length = 0;
      requests.length = 0;
      rejected.length = 0;
      logs.length = 0;
      for (const [name, source] of Object.entries(options.bindings || {}))
        vm.runInContext(`globalThis.${name} = (\n${source}\n);`, context);
      vm.runInContext("__beginCell()", context);
      context.__attached = KEY;
      vm.runInContext(
        "__attachedTarget = __attached; __lastTarget = undefined; bu.use(__attachedTarget)",
        context,
      );
      // A cell starts after the last look at the page: ids the text uses (bu.click(id)) are in
      // the state the agent was shown.
      const prelude = options.prelude ? "await bu.state();\n" : "";
      // A one-line call is a value (docs write `await page.read()`); a fence is a cell body.
      const body = options.expression
        ? `(async () => {\n${prelude}return await (\n${code}\n);\n})()`
        : `(async () => {\n${prelude}${code}\n})()`;
      let value;
      let error;
      try {
        value = await vm.runInContext(body, context);
      } catch (caught) {
        error = caught;
      }
      // Calls the example did not await still settle before the cell ends, as in the sandbox.
      await new Promise((done) => setImmediate(done));
      try {
        await vm.runInContext("__finishCell()", context);
      } catch {
        // The final observation is best effort, as in the sandbox.
      }
      await new Promise((done) => setImmediate(done));
      for (const id of [...timers]) stop(id);
      return { value, error, steps: [...steps], rejected: [...rejected], logs: [...logs] };
    },
    close() {
      for (const id of [...timers]) stop(id);
    },
  };
}

function describe(example) {
  return `${example.file}${example.line ? `:${example.line}` : ""}: ${example.code.replace(/\n/g, " ⏎ ").slice(0, 200)}`;
}

test("every documented code example sends only steps the engine schema accepts", async () => {
  const source = await sandboxSource();
  const { examples: found, skipped } = examples();
  const help = await helpCalls();
  const runnable = [];
  const signatures = [];
  const unmarked = [];
  for (const example of [...found, ...help]) {
    const names = freeNames(example.code, example.kind);
    if (names.length === 0) runnable.push(example);
    else if (example.kind === "fence" && names.every((name) => name in STAND_INS))
      runnable.push({ ...example, bindings: own(names, STAND_IN_SOURCE) });
    else if (example.kind === "fence") unmarked.push({ ...example, names });
    else if (names.every((name) => name in PLACEHOLDERS))
      runnable.push({ ...example, bindings: own(names, PLACEHOLDERS) });
    else signatures.push({ ...example, names });
  }
  assert.deepEqual(
    unmarked.map(describe),
    [],
    "a fenced example that needs values the reader must invent is marked `// no-run: why`",
  );
  assert.ok(
    runnable.length >= 200,
    `the agent text still carries its examples (${runnable.length})`,
  );

  const failures = [];
  for (const example of runnable) {
    const box = await realm(source);
    const result = await box.cell(example.code, {
      expression: example.kind === "call",
      bindings: example.bindings,
      // An id the text uses (bu.click(id)) is one the last look at the page printed.
      prelude: example.names?.includes("id") === true,
    });
    for (const rejected of result.rejected)
      failures.push(`${describe(example)}\n  ${rejected.message}`);
    // An unawaited call that the engine refused must fail the test too, not just its own promise.
    if (result.error && result.rejected.length)
      failures.push(`${describe(example)}\n  ${result.error.message}`);
  }
  assert.deepEqual(
    failures,
    [],
    `documented examples the engine rejects:\n${failures.join("\n")}\n` +
      `${runnable.length} examples ran, ${signatures.length} one-line calls are signatures (values left to the reader)`,
  );
  assert.ok(signatures.length < 200, "most one-line calls are runnable as written");
  const fenced = runnable.filter((example) => example.kind === "fence").length;
  console.log(
    `[doc-calls] ${runnable.length} examples ran (${fenced} fenced, ${runnable.length - fenced} documented calls), ` +
      `${signatures.length} signatures skipped (values left to the reader, not examples), ` +
      `${skipped.length} marked no-run`,
  );
  for (const signature of signatures)
    console.log(`[doc-calls] signature: ${signature.code} [${signature.names.join(", ")}]`);
});

function own(names, values) {
  return Object.fromEntries(names.map((name) => [name, values[name]]));
}

test("partial examples are marked and counted", async () => {
  const { examples: found, skipped } = examples();
  assert.ok(skipped.length <= 3, `${skipped.length} examples are marked no-run; keep this small`);
  for (const example of skipped)
    assert.ok(example.reason.trim().length > 10, `${describe(example)} says why it does not run`);
  assert.ok(found.length + skipped.length >= 4, "the fenced examples are still found");
});

test("a partial example is skipped only with its reason", () => {
  const { examples: found, skipped } = extract([
    {
      path: "example.md",
      text: "```js\n// no-run: needs a signed-in account the fake does not model\nawait page.act('x')\n```\n",
    },
  ]);
  assert.equal(found.length, 0);
  assert.match(skipped[0].reason, /signed-in account/);
});

test("a target reaches every step as its key, whatever form the call used", async () => {
  const source = await sandboxSource();
  const forms = [
    `return await browser.page(${TAB_ID}).evaluate(() => 'marker-eval')`,
    "return await browser.page('p1').evaluate(() => 'marker-eval')",
    "const tabs = await browser.tabs();\nreturn await browser.page(tabs[0]).evaluate(() => 'marker-eval')",
    "return await browser.tab('p1').then((tab) => tab.evaluate(() => 'marker-eval'))",
    `return await browser.attachTab(${TAB_ID})`,
  ];
  for (const form of forms) {
    const box = await realm(source);
    const result = await box.cell(form);
    assert.deepEqual(
      result.rejected,
      [],
      `${form}: ${result.rejected.map((item) => item.message).join("; ")}`,
    );
    for (const step of result.steps)
      if (step.target)
        assert.deepEqual(step.target, KEY, `${form} sent ${step.op} to a raw target`);
  }
});

test("one resolver binds every step: no code path reaches the raw transport", () => {
  const source = readdirSync(join(engine, "src"))
    .filter((name) => /^code-api.*\.ts$/.test(name))
    .map((name) => read(join(engine, "src", name)))
    .join("\n");
  assert.equal(
    [...source.matchAll(/__hostCall\s*\(/g)].length,
    1,
    "the raw transport is called once, with the request the binder returned",
  );
  assert.match(source, /var __hostCall = __call;/);
  assert.match(
    source,
    /__call = async function \(request\) \{\s*return __hostCall\(await __bindRequest\(request\)\);/,
  );
  assert.match(
    source,
    /async function __bindRequest\(request\) \{[\s\S]{0,700}?__boundTarget\(request\.target\)/,
  );
  for (const key of ["signIn", "fillCode", "fillProfile", "handoff", "media", "quiet"])
    assert.ok(
      source.includes(`'${key}'`),
      `__bindRequest binds the ${key} request's nested target`,
    );
  assert.match(source, /async function __boundTarget\(target\)/);
  for (const form of [
    /typeof target === 'number'/,
    /typeof target === 'string'/,
    /target\.target/,
    /__isTargetKey\(target\)/,
  ])
    assert.match(source, form, `__boundTarget still accepts ${form}`);
});

test("a nested target is bound too, so no request carries a raw tab id or label", async () => {
  const source = await sandboxSource();
  const forms = [
    `return await bu.handoff('Please finish the check', {target: ${TAB_ID}})`,
    `return await bu.signIn({target: ${TAB_ID}})`,
    `return await bu.fillCode({target: ${TAB_ID}})`,
    `return await bu.fillProfile({target: ${TAB_ID}})`,
  ];
  for (const form of forms) {
    const box = await realm(source);
    const result = await box.cell(form);
    assert.equal(result.error, undefined, `${form}: ${result.error?.message}`);
    assert.deepEqual(
      result.rejected,
      [],
      `${form}: ${result.rejected.map((item) => item.message).join("; ")}`,
    );
    const nested = box.requests.find(
      (request) => request.signIn || request.fillCode || request.fillProfile || request.handoff,
    );
    assert.ok(nested, `${form} reached the host`);
    const call = nested.signIn || nested.fillCode || nested.fillProfile || nested.handoff;
    assert.deepEqual(call.target, KEY, `${form} sent ${JSON.stringify(call.target)}`);
  }
});
