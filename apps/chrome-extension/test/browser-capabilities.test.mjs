import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { browserFixture } from "./browser-fixture-helper.mjs";
test("events, uploads, frame routing and native interaction work in real Chrome", async (t) => {
  const f = await browserFixture(),
    target = {
      clientInstanceId: randomUUID(),
      browserRunId: randomUUID(),
      tabIncarnation: randomUUID(),
      tabId: 1,
    };
  const request = (step) => ({ chatId: "test", step: { target, ...step } });
  try {
    await t.test("events buffer before polling, reject another chat and dispose listeners", () =>
      eventsCase(f, request),
    );
    await t.test("hidden file input receives real local bytes and change events", () =>
      uploadCase(f, request),
    );
    await t.test("native pointer and keyboard operate on rich editable content", async () => {
      await f.setPage('<div contenteditable id="edit" style="width:300px;height:100px"></div>');
      await f.api.executeInteraction(f.debuggee, {
        op: "pointer",
        action: "doubleClick",
        x: 30,
        y: 30,
      });
      await f.evaluate(
        "document.querySelector('#edit').focus();document.querySelector('#edit').textContent='old'",
      );
      await f.api.executeInteraction(f.debuggee, { op: "keys", keys: "Control+a" });
      await f.send("Input.insertText", { text: "new" });
      assert.equal(await f.evaluate("document.querySelector('#edit').textContent"), "new");
    });
    await t.test("cross-origin child frame evaluation, typing and stale frame detection", () =>
      frameCase(f),
    );
    await t.test("downloads report actual lifecycle metadata and reject another chat", () =>
      downloadCase(f, request),
    );
    await t.test("background viewport override restores the user's dimensions", () =>
      viewportCase(f),
    );
  } finally {
    f.api.releaseBrowserEvents();
    await f.close();
  }
});
async function frameCase(f) {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      req.url === "/child"
        ? '<input id="input"><button id="go" onclick="document.body.dataset.clicked=\'yes\'">Go</button>'
        : '<iframe src="http://localhost:' + server.address().port + '/child"></iframe>',
    );
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  try {
    await f.send("Page.navigate", { url: "http://127.0.0.1:" + server.address().port + "/" });
    let child;
    for (let i = 0; i < 30; i++) {
      child = (await f.api.discoverFrames(f.debuggee)).find((frame) =>
        frame.url.includes("localhost"),
      );
      if (child?.frameKey.split(":").at(-1)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(child);
    assert.ok(child.sessionId, "Cross-origin frame should use its own renderer session");
    await assert.rejects(f.api.frameDebuggee(f.debuggee, child.frameId), (error) =>
      /Use a handle returned by page.frames/.test(error.detail),
    );
    const scoped = await f.api.frameDebuggee(f.debuggee, child.frameId, child.frameKey);
    await f.api.interactFrame(scoped, child.frameId, "#input", "typed in child");
    assert.equal(
      await f.api.evaluateFrame(scoped, child.frameId, "document.querySelector('#input').value"),
      "typed in child",
    );
    await f.api.interactFrame(scoped, child.frameId, "#go");
    assert.equal(
      await f.api.evaluateFrame(scoped, child.frameId, "document.body.dataset.clicked"),
      "yes",
    );
    await assert.rejects(f.api.frameDebuggee(f.debuggee, child.frameId, "old"), /STALE_REF/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function uploadCase(f, request) {
  const path = join(f.folder, "upload.txt");
  await writeFile(path, "actual local content");
  await f.setPage('<input type="file" id="file" hidden onchange="window.uploadChanged=true">');
  const result = await f.api.uploadFiles(
    f.debuggee,
    request({ op: "upload", selector: "#file", files: [path] }),
  );
  assert.equal(result.files[0].name, "upload.txt");
  assert.equal(
    await f.evaluate("document.querySelector('#file').files[0].text()"),
    "actual local content",
  );
  assert.equal(await f.evaluate("window.uploadChanged"), true);
}
async function downloadCase(f, request) {
  let item = {
    id: 701,
    url: "https://example.test/export.csv",
    filename: join(f.folder, "export.csv"),
    state: "in_progress",
    bytesReceived: 0,
    totalBytes: 10,
    exists: false,
  };
  chrome.downloads = {
    download: async () => 701,
    search: async () => [item],
    cancel: async () => {
      item = { ...item, state: "interrupted", error: "USER_CANCELED" };
    },
  };
  const started = await f.api.executeDownload(
    request({ op: "downloads", action: "start", url: item.url }),
  );
  assert.equal(started.downloadId, 701);
  await assert.rejects(
    f.api.executeDownload({
      ...request({ op: "downloads", action: "wait", downloadId: 701, timeoutMs: 0 }),
      chatId: "other",
    }),
    /INVALID_TARGET/,
  );
  const progress = await f.api.executeDownload(
    request({ op: "downloads", action: "wait", downloadId: 701, timeoutMs: 0 }),
  );
  assert.equal(progress.state, "in_progress");
  item = { ...item, state: "complete", bytesReceived: 10, exists: true };
  const completed = await f.api.executeDownload(
    request({ op: "downloads", action: "wait", downloadId: 701, timeoutMs: 0 }),
  );
  assert.equal(completed.filename, item.filename);
  assert.equal(completed.state, "complete");
  await f.api.executeDownload(request({ op: "downloads", action: "cancel", downloadId: 701 }));
}
async function viewportCase(f) {
  const before = (await f.send("Page.getLayoutMetrics")).cssVisualViewport.clientWidth;
  chrome.tabs.get = async () => ({ id: 1, active: false });
  await f.api.ensureBrowserViewport(1);
  assert.equal((await f.send("Page.getLayoutMetrics")).cssVisualViewport.clientWidth, 1280);
  await f.api.restoreBrowserViewport(1);
  // CDP acknowledges the clear before the renderer applies the next layout.
  await f.evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
  );
  assert.equal((await f.send("Page.getLayoutMetrics")).cssVisualViewport.clientWidth, before);
}

async function eventsCase(f, request) {
  const sub = await f.api.executeBrowserEvent(
    request({ op: "event", action: "subscribe", event: "Page.domContentEventFired" }),
    f.debuggee,
  );
  await f.send("Page.navigate", { url: "data:text/html,<p>Ready</p>" });
  const result = await f.api.executeBrowserEvent(
    request({
      op: "event",
      action: "poll",
      subscriptionId: sub.subscriptionId,
      timeoutMs: 5000,
    }),
    f.debuggee,
  );
  assert.ok(result.events.length);
  await assert.rejects(
    f.api.executeBrowserEvent(
      {
        ...request({ op: "event", action: "poll", subscriptionId: sub.subscriptionId }),
        chatId: "other",
      },
      f.debuggee,
    ),
    /INVALID_TARGET/,
  );
  await f.api.executeBrowserEvent(
    request({ op: "event", action: "dispose", subscriptionId: sub.subscriptionId }),
    f.debuggee,
  );
}
