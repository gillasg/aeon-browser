import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  outsideContextAnswer,
  readOutsideContext,
  writeOutsideContext,
} from "../dist/outside-context.js";

async function folder(t) {
  const directory = await mkdtemp(join(tmpdir(), "aeon-outside-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("open tabs are off until the user turns them on", async (t) => {
  const directory = await folder(t);
  assert.equal(await readOutsideContext(directory), false);
  let asked = 0;
  const answer = await outsideContextAnswer(directory, async () => {
    asked += 1;
    return [{ title: "Inbox", url: "https://mail.example/", active: true }];
  });
  assert.equal(answer.enabled, false);
  assert.deepEqual(answer.tabs, []);
  assert.match(answer.hint, /Aeon Settings/);
  assert.equal(asked, 0, "nothing is read from the browser while it is off");
});

test("turning it on returns titles and URLs of web tabs only", async (t) => {
  const directory = await folder(t);
  await writeOutsideContext(directory, true);
  assert.equal(await readOutsideContext(directory), true);
  const answer = await outsideContextAnswer(directory, async () => [
    { title: "Inbox", url: "https://mail.example/", active: false },
    { title: "Aeon", url: "chrome-extension://abc/sidepanel.html", active: true },
    { title: "New tab", url: "chrome://newtab/", active: false },
  ]);
  assert.equal(answer.enabled, true);
  assert.deepEqual(answer.tabs, [{ title: "Inbox", url: "https://mail.example/", active: false }]);
});

test("the daemon answers context and routine as external tools", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-outside-context-"));
  const { ChatService } = await import("../dist/chat-service.js");
  const { FakePiPort } = await import("./fake-pi-port.mjs");
  const { openChatStore } = await import("@aeon/store");
  const store = openChatStore(join(directory, "data"));
  const service = new ChatService({
    dataDirectory: join(directory, "data"),
    store,
    pi: new FakePiPort(),
  });
  t.after(async () => {
    service.projects.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const names = service.externalTools().map((tool) => tool.name);
  assert.ok(names.includes("context"));
  assert.ok(names.includes("routine"));
  service.setExternalContextReader(async () => ({
    enabled: true,
    tabs: [{ title: "Inbox", url: "https://mail.example/", active: true }],
  }));
  const answer = await service.callExternalTool("context", "mcp", {});
  assert.equal(answer.isError, false);
  const value = JSON.parse(answer.content[0].text);
  assert.deepEqual(value.tabs, [{ title: "Inbox", url: "https://mail.example/", active: true }]);
});
