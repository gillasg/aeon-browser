import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBrowserCodeTool } from "../dist/browser-code-tool.js";
import { disposeBrowserRuntime } from "../dist/browser-code-runtime.js";
import { workspaceCall } from "../dist/browser-workspace.js";
test("workspace checkpoints, binary artifacts, helpers and images use the chat workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "aeon-workspace-")),
    chat = randomUUID();
  const tool = createBrowserCodeTool(chat, undefined, root);
  try {
    const result = await tool.execute("files", {
      code: `await checkpoint('progress.json',{rows:[1,2]});await checkpoint('progress.json',{rows:[3]});await artifact('bytes.bin',new Uint8Array([0,128,255]));await saveHelper('double.js',x=>x*2);const double=await loadHelper('double.js');const rows=await loadCheckpoint('progress.json');finish_from_js({expression:'[rows.rows,double(21)]'});'do not replace delivery'`,
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text).value, [[3], 42]);
    assert.deepEqual([...(await readFile(join(root, "bytes.bin")))], [0, 128, 255]);
    await assert.rejects(
      workspaceCall(root, { workspace: "artifact", name: "../escape", value: "x" }),
      /outside/,
    );
    await assert.rejects(
      workspaceCall(root, { workspace: "artifact", name: "bytes.bin", value: "x" }),
      /EEXIST/,
    );
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF5sAAAAASUVORK5CYII=",
      "base64",
    );
    await workspaceCall(root, { workspace: "artifact", name: "image.png", value: [...image] });
    const shown = await tool.execute("image", { code: "await showImage('image.png')" });
    assert.equal(shown.content.at(-1).type, "image");
  } finally {
    disposeBrowserRuntime(chat);
    await rm(root, { recursive: true, force: true });
  }
});
test("event registration precedes actions and event handles persist across cells", async () => {
  const chat = randomUUID(),
    target = {
      clientInstanceId: randomUUID(),
      browserRunId: randomUUID(),
      tabIncarnation: randomUUID(),
      tabId: 1,
    },
    calls = [];
  const tool = createBrowserCodeTool(chat, async (_chat, _id, { steps }) => {
    const step = steps[0];
    calls.push(step.action ?? step.op);
    const data =
      step.action === "subscribe"
        ? { subscriptionId: randomUUID() }
        : step.action === "poll"
          ? { events: [{ method: "popup", params: { tabId: 2 } }] }
          : step.method === "Page.captureScreenshot"
            ? { value: { data: "aW1hZ2U=" } }
            : {};
    const result =
      step.op === "observe"
        ? {
            kind: "semantic",
            target,
            nodes: [],
            url: "https://example.test",
            documentEpoch: 1,
            snapshotId: randomUUID(),
            truncated: false,
          }
        : { kind: "page", target, data };
    return JSON.stringify({ steps: [{ disposition: "completed", index: 0, result }] });
  });
  try {
    await tool.execute("subscribe", {
      code: `bu.use(${JSON.stringify(target)});const next=page.waitForEvent('popup');await next.ready;`,
    });
    const result = await tool.execute("act", {
      code: "await page.clickAt(10,20);const observed=await next;observed.params.tabId",
    });
    assert.equal(JSON.parse(result.content[0].text).value, 2);
    assert.deepEqual(calls, ["subscribe", "click", "poll", "dispose", "observe"]);
    const image = await tool.execute("cdp-image", {
      code: "await page.cdp('Page.captureScreenshot')",
    });
    assert.equal(image.content.at(-1).type, "image");
    assert.equal(image.content.at(-1).data, "aW1hZ2U=");
  } finally {
    disposeBrowserRuntime(chat);
  }
});
