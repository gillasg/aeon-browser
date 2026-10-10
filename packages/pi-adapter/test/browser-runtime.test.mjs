import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  BrowserCodeRuntime,
  browserRuntime,
  disposeBrowserRuntime,
} from "../dist/browser-code-runtime.js";
import { createBrowserCodeTool } from "../dist/browser-code-tool.js";
import { installBrowserSessionLifecycle } from "../dist/browser-session-lifecycle.js";
const { AbortController } = globalThis;
const unused = async () => assert.fail("Unexpected browser call");
test("a caught helper failure can recover through evaluation and CDP in the same cell", async () => {
  const chat = randomUUID(),
    target = {
      clientInstanceId: randomUUID(),
      browserRunId: randomUUID(),
      tabId: 1,
      tabIncarnation: randomUUID(),
    },
    calls = [];
  const tool = createBrowserCodeTool(chat, async (_chat, _call, { steps }) => {
    const step = steps[0];
    calls.push(step.op);
    if (step.op === "fill")
      return JSON.stringify({ steps: [{ index: 0, disposition: "failed", code: "NOT_EDITABLE" }] });
    const base = { target, url: "https://example.test", documentEpoch: 1 };
    const result =
      step.op === "observe"
        ? { ...base, kind: "semantic", snapshotId: randomUUID(), nodes: [], truncated: false }
        : {
            ...base,
            kind: "page",
            data: { value: step.op === "evaluate" ? 42 : { result: { value: 7 } } },
          };
    return JSON.stringify({ steps: [{ index: 0, disposition: "completed", result }] });
  });
  try {
    const result = await tool.execute("recover", {
      code: `bu.use(${JSON.stringify(target)}); try {await page.getByRole('button',{name:'Go'}).fill('text')}catch{}; const answer=await page.evaluate(()=>6*7); const raw=await page.cdp('Runtime.evaluate',{expression:'7'}); [answer,raw.result.value]`,
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text).value, [42, 7]);
    assert.deepEqual(calls, ["fill", "evaluate", "cdp", "observe"]);
  } finally {
    disposeBrowserRuntime(chat);
  }
});
test("response completion releases browser ownership without clearing the chat runtime", async () => {
  const chat = randomUUID(),
    runtime = browserRuntime(chat),
    calls = [];
  let emit;
  try {
    await runtime.execute("const remembered='same chat'", unused);
    installBrowserSessionLifecycle(
      {
        subscribe: (listener) => {
          emit = listener;
        },
      },
      chat,
      async (...args) => {
        calls.push(args);
        return "{}";
      },
    );
    emit({ type: "agent_end" });
    assert.equal((await runtime.execute("remembered", unused)).value, "same chat");
    assert.deepEqual(calls[0][2], { release: true });
  } finally {
    disposeBrowserRuntime(chat);
  }
});
test("bindings, helpers and top-level await persist in one chat and remain isolated", async () => {
  const a = new BrowserCodeRuntime(),
    b = new BrowserCodeRuntime();
  try {
    assert.equal(
      (
        await a.execute(
          "const value=40; const increment=n=>n+2; await Promise.resolve(value)",
          unused,
        )
      ).value,
      40,
    );
    assert.equal((await a.execute("increment(value)", unused)).value, 42);
    assert.equal((await b.execute("typeof value", unused)).value, "undefined");
    assert.equal((await a.execute("const value=41; value", unused)).value, 41);
    assert.equal((await a.execute("return 7;", unused)).value, 7);
  } finally {
    a.close();
    b.close();
  }
});
test("queued cells serialize and use the current call bridge", async () => {
  const runtime = new BrowserCodeRuntime(),
    calls = [];
  try {
    const first = runtime.execute(
      "const stored=await __call({op:'first'}); stored",
      async (step) => {
        calls.push(step.op);
        await new Promise((r) => setTimeout(r, 20));
        return 5;
      },
    );
    const second = runtime.execute("stored + await __call({op:'second'})", async (step) => {
      calls.push(step.op);
      return 6;
    });
    assert.deepEqual(
      (await Promise.all([first, second])).map((result) => result.value),
      [5, 11],
    );
    assert.deepEqual(calls, ["first", "second"]);
  } finally {
    runtime.close();
  }
});
test("errors preserve bindings; cancellation kills execution and reports the next reset", async () => {
  const runtime = new BrowserCodeRuntime();
  try {
    await runtime.execute("const retained=9", unused);
    await assert.rejects(runtime.execute("throw Error('recoverable')", unused), /recoverable/);
    assert.equal((await runtime.execute("retained", unused)).value, 9);
    const controller = new AbortController();
    const work = runtime.execute("while(true) {}", unused, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(work, /cancelled.*reset/);
    const next = await runtime.execute("typeof retained", unused);
    assert.equal(next.reset, true);
    assert.equal(next.value, "undefined");
    assert.equal((await runtime.execute("const rebuilt=42; rebuilt", unused)).reset, undefined);
  } finally {
    runtime.close();
  }
});
test("deadlines reset an infinite cell and closed runtimes cannot run queued cells", async () => {
  const runtime = new BrowserCodeRuntime(150);
  try {
    await assert.rejects(runtime.execute("while(true){}", unused), /deadline.*reset/);
    assert.equal((await runtime.execute("21*2", unused)).value, 42);
    runtime.close();
    await assert.rejects(runtime.execute("1", unused), /closed/);
  } finally {
    runtime.close();
  }
});
test("compact helpers batch actions with one final state and preserve page objects across calls", async () => {
  const chat = randomUUID(),
    target = {
      clientInstanceId: randomUUID(),
      browserRunId: randomUUID(),
      tabId: 1,
      tabIncarnation: randomUUID(),
    };
  const calls = [];
  const run = async (_chat, _call, { steps }) => {
    const step = steps[0];
    calls.push(step);
    const base = { target, url: "https://example.test", documentEpoch: 1 };
    const result =
      step.op === "observe"
        ? {
            ...base,
            kind: "semantic",
            snapshotId: randomUUID(),
            nodes: [{ ref: "e0", backendNodeId: 12, role: "button", name: "Go", expanded: false }],
            truncated: false,
          }
        : { ...base, kind: "action" };
    return JSON.stringify({ steps: [{ index: 0, disposition: "completed", result }] });
  };
  const tool = createBrowserCodeTool(chat, run);
  try {
    let output = await tool.execute("bind", {
      code: `bu.use(${JSON.stringify(target)}); await bu.state()`,
    });
    assert.equal(output.isError, undefined);
    assert.match(JSON.parse(output.content[0].text).output, /\[12\] button/);
    calls.length = 0;
    output = await tool.execute("act", {
      code: "await bu.click(12); await bu.type(12,'hello',{enter:true})",
    });
    assert.equal(output.isError, undefined);
    assert.deepEqual(
      calls.map((s) => s.op),
      ["click", "fill", "press", "observe"],
    );
    assert.equal(calls[0].observe, false);
    assert.deepEqual(calls[0].element, { kind: "backend", backendNodeId: 12, documentEpoch: 1 });
    assert.equal((await browserRuntime(chat).execute("page.target.tabId", unused)).value, 1);
  } finally {
    disposeBrowserRuntime(chat);
  }
});
