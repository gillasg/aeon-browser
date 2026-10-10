import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createBrowserCodeTool } from "../dist/browser-code-tool.js";
import { disposeBrowserRuntime } from "../dist/browser-code-runtime.js";
test("documented browser entrypoint opens and scrolls in one cell and accepts tabs.list", async () => {
  const chat = randomUUID(),
    calls = [];
  const target = {
    clientInstanceId: randomUUID(),
    browserRunId: randomUUID(),
    tabIncarnation: randomUUID(),
    tabId: 1,
  };
  const tool = createBrowserCodeTool(chat, async (_chat, _id, input) => {
    if (input.browserInfo) {
      calls.push("browserInfo");
      return JSON.stringify({ clientInstanceIds: [target.clientInstanceId] });
    }
    const { steps } = input;
    const step = steps[0];
    calls.push(step.op);
    let result = {
      kind: "semantic",
      target,
      nodes: [],
      snapshotId: randomUUID(),
      documentEpoch: 1,
      url: "https://example.test",
      truncated: false,
    };
    if (step.op === "listTabs") result = { kind: "tabs", tabs: [] };
    if (step.op === "openTab") result = { kind: "tab", tab: { target } };
    if (step.op === "scroll")
      result = { kind: "action", target, scroll: { position: 800, moved: true } };
    return JSON.stringify({ steps: [{ disposition: "completed", index: 0, result }] });
  });
  try {
    assert.match(tool.description, /not in codemode/);
    const empty = await tool.execute("list", { code: "(await browser.tabs.list()).length" });
    assert.equal(JSON.parse(empty.content[0].text).value, 0);
    calls.length = 0;
    const result = await tool.execute("one-workflow", {
      code: "const page=await browser.openTab('https://www.yahoo.com/');const scrolled=await page.scroll('down',800);scrolled.scroll.position",
    });
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.equal(JSON.parse(result.content[0].text).value, 800);
    assert.deepEqual(calls, ["browserInfo", "openTab", "scroll", "observe"]);
  } finally {
    disposeBrowserRuntime(chat);
  }
});
