import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserCodeTool, createBrowserTools } from "../dist/browser-code-tool.js";
import { createBrowserControlTool, browserContent } from "../dist/browser-tool.js";
import { randomUUID } from "node:crypto";
const target = {
  clientInstanceId: randomUUID(),
  browserRunId: randomUUID(),
  tabId: 1,
  tabIncarnation: randomUUID(),
};
const pageResult = (data) => ({
  kind: "page",
  target,
  data,
  url: "https://example.test",
  documentEpoch: 1,
});
const completed = (result) =>
  JSON.stringify({ steps: [{ index: 0, disposition: "completed", result }] });

test("code mode fills, submits, waits and extracts without tab rediscovery or verbose traces", async () => {
  const calls = [];
  const run = async (_chat, _id, { steps }) => {
    calls.push(steps[0]);
    return completed(
      pageResult(
        steps[0].op === "read"
          ? { items: [{ text: "Recommended books", unused: "x".repeat(10000) }] }
          : { found: true },
      ),
    );
  };
  const tool = createBrowserCodeTool(randomUUID(), run);
  const result = await tool.execute("workflow", {
    code: `const page=browser.page(${JSON.stringify(target)});
    await page.getByPlaceholder('Search').fill('Marie Antoinette');
    await page.getByPlaceholder('Search').press('Enter');
    await page.wait('#results',{state:'visible',timeoutMs:1000});
    const links=await page.read('#results a'); return links.data.items.map(item=>item.text);`,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    calls.map((step) => step.op),
    ["fill", "press", "wait", "read", "observe"],
  );
  assert.ok(calls.every((step) => step.target.tabId === target.tabId));
  const output = JSON.parse(result.content[0].text);
  assert.deepEqual(output.value, ["Recommended books"]);
  assert.ok(result.content[0].text.length < 4000);
  assert.equal(output.steps[3].result.data.omitted, true);
});

test("failed browser operations are errors and repeated failures are bounded across both tools", async () => {
  let calls = 0;
  const run = async (_chat, _id, input) => {
    if (input.steps[0].op === "observe")
      return completed({
        kind: "semantic",
        target,
        documentEpoch: 1,
        snapshotId: randomUUID(),
        url: "https://example.test",
        nodes: [],
        truncated: false,
      });
    calls++;
    return JSON.stringify({
      steps: [
        {
          index: 0,
          disposition: "failed",
          code: "TARGET_NOT_FOUND",
          detail: "Use a combobox named Search",
        },
      ],
    });
  };
  const tools = createBrowserTools(randomUUID(), run);
  const control = tools.find((tool) => tool.name === "browser_control");
  const code = tools.find((tool) => tool.name === "browser_code");
  const step = {
    op: "fill",
    target,
    element: { kind: "locator", role: "search", name: "" },
    value: "test",
  };
  assert.equal((await control.execute("first", { steps: [step] })).isError, true);
  assert.equal((await control.execute("second", { steps: [step] })).isError, true);
  const result = await code.execute("third", {
    code: `return await browser.page(${JSON.stringify(target)}).fill(${JSON.stringify(step.element)},'test');`,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /NO_PROGRESS/);
  assert.equal(calls, 2);
});

test("recoverable workflow errors preserve the browser session and include actionable detail", async () => {
  const inputs = [];
  const tool = createBrowserCodeTool(randomUUID(), async (_chat, _id, input) => {
    inputs.push(input);
    if (input.steps?.[0].op === "observe")
      return completed({
        kind: "semantic",
        target,
        documentEpoch: 1,
        snapshotId: randomUUID(),
        url: "https://example.test",
        nodes: [],
        truncated: false,
      });
    return JSON.stringify({
      steps: [
        {
          index: 0,
          disposition: "failed",
          code: "AMBIGUOUS_TARGET",
          detail: "Scope to one container",
        },
      ],
    });
  });
  const result = await tool.execute("failed", {
    code: `return await browser.page(${JSON.stringify(target)}).getByRole('button',{name:'Ask'}).click();`,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Scope to one container/);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1].steps[0].op, "observe");
  assert.ok(!inputs[0].release);
});

test("browser output strips every screenshot payload and deduplicates the attached images", () => {
  const screenshot = (id) => ({
    kind: "screenshot",
    screenshotId: id,
    dataBase64: `image-${id}`,
    mimeType: "image/jpeg",
  });
  const output = browserContent(
    JSON.stringify({ steps: [screenshot("a"), screenshot("b")], value: screenshot("b") }),
  );
  assert.ok(!output[0].text.includes("dataBase64"));
  assert.deepEqual(
    output.slice(1).map((image) => image.data),
    ["image-a", "image-b"],
  );
});

test("browser control reports offline as an actual tool error", async () => {
  const result = await createBrowserControlTool(randomUUID(), undefined).execute("offline", {
    steps: [],
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /BROWSER_OFFLINE/);
});
