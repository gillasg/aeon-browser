import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { compactBrowserTrace } from "../dist/browser-recovery.js";
import { BrowserCodeRuntime } from "../dist/browser-code-runtime.js";

test("idle garbage collection preserves the chat realm and its bindings", async () => {
  const worker = fork(new URL("../dist/browser-code-worker.js", import.meta.url), [], {
    execArgv: [
      "--expose-gc",
      "--import",
      new URL("./fixtures/browser-gc.mjs", import.meta.url).href,
    ],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  let sequence = 0;
  const execute = (code) =>
    new Promise((resolve, reject) => {
      const id = String(++sequence);
      const onMessage = (result) => {
        if (result.kind !== "result" || result.id !== id) return;
        worker.off("message", onMessage);
        worker.off("exit", onExit);
        resolve(result);
      };
      const onExit = () => reject(new Error("Worker exited"));
      worker.on("message", onMessage);
      worker.once("exit", onExit);
      worker.send({ kind: "cell", id, code });
    });
  try {
    assert.equal((await execute("const remembered=42; remembered")).value, 42);
    await setTimeout(250);
    const result = await execute("remembered");
    assert.equal(result.error, undefined);
    assert.equal(result.value, 42);
  } finally {
    worker.kill();
  }
});

test("observation traces keep bounded evidence without repeating the full page", () => {
  const result = compactBrowserTrace({
    kind: "semantic",
    nodes: [{}],
    text: "x".repeat(16000),
    url: "https://example.test",
  });
  assert.equal(result.text.length, 3000);
  assert.equal(result.textClipped, true);
  assert.equal(result.nodeCount, 1);
  assert.equal(result.nodes, undefined);
});

test("opened page handles expose metadata and print concise evidence", async () => {
  const runtime = new BrowserCodeRuntime();
  const target = { clientInstanceId: "browser", tabId: 1 };
  const call = async (step) =>
    step.browserInfo
      ? { clientInstanceIds: ["browser"] }
      : { kind: "tab", tab: { target, url: "https://example.test", title: "Example" } };
  try {
    const result = await runtime.execute(
      "const opened=await browser.openTab('https://example.test'); console.log(opened); [opened.url,opened.title]",
      call,
    );
    assert.deepEqual(result.value, ["https://example.test", "Example"]);
    assert.match(result.output, /Example/);
    assert.doesNotMatch(result.output, /\[Function/);
  } finally {
    runtime.close();
  }
});
