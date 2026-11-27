// The L2 contract: graft-l2-contract.d.ts type-checks under --strict with a realistic cell and
// stays short, and the realm carries what it promises: human.*, site.*, page.ref, page.wire,
// help(topic) and tab-qualified refs (t<tab>:e<id>) that never act on another tab.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ERRORS } from "@browserkit/protocol";
import { BrowserRealmServer } from "../dist/code-realm-server.js";

const contract = fileURLToPath(new URL("../contract/graft-l2-contract.d.ts", import.meta.url));
const usage = fileURLToPath(new URL("../contract/l2-usage.ts", import.meta.url));
const ts = createRequire(import.meta.url)("typescript");

// TypeScript hands the host forward-slash paths even on Windows, where fileURLToPath returns
// backslashes, so overlay keys are normalized once and every lookup goes through the same rule.
const norm = (p) => p.replace(/\\/g, "/");

function diagnose(files, extra = {}) {
  const overlay = new Map(Object.entries(extra).map(([name, text]) => [norm(name), text]));
  const host = ts.createCompilerHost({});
  const read = host.readFile.bind(host);
  host.readFile = (name) => (overlay.has(norm(name)) ? overlay.get(norm(name)) : read(name));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => overlay.has(norm(name)) || fileExists(name);
  const options = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: [],
  };
  const program = ts.createProgram([...files, ...overlay.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

test("the L2 contract and a usage sample compile under tsc --strict --noEmit", () => {
  assert.deepEqual(diagnose([contract, usage]), []);
});

test("the contract rejects misuse: a bare ref string is not a Ref, and handoff kinds are closed", () => {
  const bad = fileURLToPath(new URL("../contract/__bad.ts", import.meta.url));
  const errors = diagnose([contract], {
    [bad]: `export async function bad(){ const r: \`t\${number}:e\${number}\` = "e12"; await human.handoff("x", {kind: "pay"}); return r; }`,
  });
  assert.equal(errors.length, 2, errors.join("\n"));
});

test("the contract stays at or under 120 lines", () => {
  const lines = readFileSync(contract, "utf8").trimEnd().split("\n").length;
  assert.ok(lines <= 120, `graft-l2-contract.d.ts is ${lines} lines`);
});

test("WRONG_TAB belongs to the closed error set with a model owner and a hint", () => {
  assert.equal(ERRORS.WRONG_TAB[0], "model");
  assert.match(ERRORS.WRONG_TAB[1], /another tab/);
});

const key = (tabId) => ({
  clientInstanceId: "11111111-1111-4111-8111-111111111111",
  browserRunId: "22222222-2222-4222-8222-222222222222",
  tabId,
  tabIncarnation: "33333333-3333-4333-8333-33333333333" + (tabId % 10),
});
const tab = (tabId) => ({
  target: key(tabId),
  windowId: 1,
  index: 0,
  url: "https://shop.test/",
  title: "Shop",
  status: "complete",
  active: tabId === 7,
  pinned: false,
  groupId: -1,
  documentEpoch: 1,
  mine: true,
});

function reply(request) {
  if (request.browserInfo) return { clientInstanceIds: [key(7).clientInstanceId] };
  if (request.op === "listTabs")
    return { kind: "tabs", focusedWindowId: 1, tabs: [tab(7), tab(8)] };
  if (request.op === "observe")
    return {
      kind: "semantic",
      target: request.target,
      url: "https://shop.test/",
      title: "Shop",
      documentEpoch: 1,
      snapshotId: "s1",
      nodes: [{ backendNodeId: 12, ref: "e12", role: "button", name: "Pay" }],
    };
  if (request.op === "evaluate") return { kind: "evaluate", data: { value: null, changed: false } };
  if (request.handoff) return "done";
  if (request.signIn) return { signedIn: true };
  if (request.fillProfile) return { filled: [], missing: [], other: [] };
  if (request.fillCode) return { filled: true, from: "gmail" };
  if (request.siteMapper) return { via: "siteMapper", ...request };
  if (request.rules) return { rules: request.rules };
  if (request.op) return { kind: "action", ok: true, target: request.target, outcome: "done" };
  return null;
}

function harness() {
  const server = new BrowserRealmServer();
  const waits = new Map();
  const calls = [];
  const socket = {
    readyState: 1,
    send(text) {
      const frame = JSON.parse(text);
      setImmediate(() => {
        if (frame.kind === "browser.realm.op.reply") return waits.get(frame.opId)?.(frame);
        if (frame.event.kind === "call") calls.push(frame.event.request);
        const value =
          frame.event.kind === "call" ? { value: reply(frame.event.request) } : { ok: true };
        server.handle({ kind: "browser.realm.event.reply", eventId: frame.eventId, value }, socket);
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
  const cell = async (code) =>
    (await op({ kind: "cell", cellId: `c${++sequence}`, chatId: "l2", code })).value;
  return { cell, calls };
}

const { cell, calls } = harness();
const named = (field) => calls.filter((call) => call && call[field]);

test("page.ref is t<tabId>, and page.wire, human, site and help are present", async () => {
  const out = await cell(
    `var p = browser.page(7); [p.ref, typeof p.wire, typeof p.rules.block, Object.keys(human).sort(), ['ops','call','watch','write','run'].map(n => typeof site[n]), typeof siteMapper.call, typeof bu.handoff]`,
  );
  assert.deepEqual(out.value, [
    "t7",
    "function",
    "function",
    ["fillCode", "fillProfile", "handoff", "signIn"],
    ["function", "function", "function", "function", "function"],
    "function",
    "function",
  ]);
});

test("human.* delegates to the existing hand-off, sign-in, profile and code helpers", async () => {
  const out = await cell(
    `var p = browser.page(7); [await human.handoff('Pay $42?', {page: p, kind: 'cliff-edge', actionLabel: 'Pay $42'}), (await human.signIn({page: p, account: 'me'})).signedIn, (await human.fillProfile({page: p})).filled.length, (await human.fillCode({page: p})).from]`,
  );
  assert.deepEqual(out.value, ["done", true, 0, "gmail"], out.error);
  const handoff = named("handoff").at(-1).handoff;
  assert.equal(handoff.kind, "cliff-edge");
  assert.equal(handoff.actionLabel, "Pay $42");
  assert.equal(handoff.target.tabId, 7);
  assert.equal(named("signIn").at(-1).signIn.account, "me");
  assert.equal(named("signIn").at(-1).signIn.target.tabId, 7);
  assert.equal(named("fillProfile").at(-1).fillProfile.target.tabId, 7);
  assert.equal(named("fillCode").at(-1).fillCode.target.tabId, 7);
});

test("human.handoff: a question carries its choices, a ref picks its tab, unknown kinds are refused", async () => {
  const asked = await cell(
    `await human.handoff('Which size?', {kind: 'question', options: ['S', 'M'], target: 't8:e3'})`,
  );
  assert.equal(asked.value, "done", asked.error);
  const handoff = named("handoff").at(-1).handoff;
  assert.equal(handoff.message, "Which size? (S / M)");
  assert.equal(handoff.kind, undefined);
  assert.equal(handoff.target.tabId, 8);
  const bad = await cell(`await human.handoff('x', {kind: 'pay'})`);
  assert.match(bad.error, /^INVALID_INPUT/);
  const wrong = await cell(`await human.handoff('x', {page: browser.page(7), target: 't8:e3'})`);
  assert.match(wrong.error, /^WRONG_TAB/);
});

test("tab-qualified refs act on their own tab and are refused on another", async () => {
  const same = await cell(
    `await browser.tabs(); var p = browser.page(7); await p.state(); await p.click('t7:e12'); await p.state(); await p.click(12); await p.state(); await p.fill('t7:e12', 'x'); 'ok'`,
  );
  assert.equal(same.value, "ok", same.error);
  const acted = calls.filter((call) => call && (call.op === "click" || call.op === "fill"));
  assert.ok(acted.length >= 3);
  for (const call of acted.slice(-3)) {
    assert.equal(call.target.tabId, 7);
    assert.equal(call.element.backendNodeId, 12);
  }
  const before = calls.length;
  for (const code of [
    `await browser.page(7).click('t8:e12')`,
    `await browser.page(7).fill('t8:e12', 'x')`,
    `await browser.page(7).press('t8:e12', 'Enter')`,
    `await browser.page(7).selectOption('t8:e12', 'a')`,
    `await browser.page(7).upload('t8:e12', ['a.png'])`,
  ]) {
    const out = await cell(code);
    assert.match(out.error, /^WRONG_TAB: t8:e12 is from tab 8/, code);
  }
  assert.equal(
    calls
      .slice(before)
      .filter((call) => call && (call.op === "click" || call.op === "fill" || call.op === "press"))
      .length,
    0,
  );
});

test("page.wire maps rules onto page.rules and undo clears them", async () => {
  const out = await cell(
    `var w = await browser.page(7).wire([{match: '||ads.test', abort: true}, {match: '*', headers: {'x-a': '1'}}, {match: '/api/x', fulfill: {json: {ok: 1}}}]); await w.undo(); typeof w.undo`,
  );
  assert.equal(out.value, "function", out.error);
  assert.deepEqual(
    named("rules")
      .slice(-4)
      .map((call) => call.rules),
    ["block", "headers", "mock", "clear"],
  );
  assert.deepEqual(named("rules").at(-4).urls, ["||ads.test"]);
  const bad = await cell(`await browser.page(7).wire([{match: /x/, abort: true}])`);
  assert.match(bad.error, /^INVALID_INPUT/);
});

test("site.ops/call/watch/write go through the mapped-site calls", async () => {
  const out = await cell(
    `[(await site.ops('a.test')).siteMapper, (await site.call('a.test', 'list', {q: 1})).siteMapper, (await site.watch('a.test', 'list')).siteMapper, (await site.write('a.test', 'post', {t: 1})).siteMapper]`,
  );
  assert.deepEqual(out.value, ["operations", "call", "watch", "write"], out.error);
  const call = named("siteMapper").find((c) => c.siteMapper === "call");
  assert.deepEqual([call.site, call.operation, call.params], ["a.test", "list", { q: 1 }]);
});

test("help() gives an overview, help(topic) gives runnable examples for the L2 topics", async () => {
  const overview = await cell(`help()`);
  assert.match(overview.value, /^L2: /);
  assert.match(overview.value, /Topics: .*human/);
  for (const topic of ["human", "site", "wire", "tap", "pool", "tabs", "refs"]) {
    const out = await cell(`help(${JSON.stringify(topic)})`);
    assert.ok(out.value.length > 40, topic);
  }
  assert.match((await cell(`help('tabs')`)).value, /page\.ref/);
  assert.match((await cell(`help('refs')`)).value, /WRONG_TAB/);
});
