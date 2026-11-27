import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pin, pinInherited } from "../dist/core-browsers.js";

function browser(list) {
  const pins = new Map();
  return {
    pins,
    connectedBrowsers: () => list(),
    pinChat(chatId, clientInstanceId) {
      pins.set(chatId, clientInstanceId);
    },
    browserOf(chatId) {
      return pins.get(chatId);
    },
    // A chat with no attached tabs has no browser of its own beyond its pin.
    codeBrowserOf() {
      return undefined;
    },
  };
}

test("pin waits when the name is known and the browser is briefly disconnected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "graft-pin-"));
  const id = "7c2f4b1e-0d5a-4e8b-9a61-3f2b8c9d0e14";
  await writeFile(join(dir, "browser-names.json"), JSON.stringify({ [id]: "recording" }));
  let connected = false;
  const control = browser(() => (connected ? [{ clientInstanceId: id, urls: [] }] : []));
  const pending = pin(control, dir, "chat-1", "recording");
  setTimeout(() => {
    connected = true;
  }, 120);
  await pending;
  assert.equal(control.browserOf("chat-1"), id);
});

test("an unknown browser name fails without waiting out the reconnect gap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "graft-pin-"));
  const control = browser(() => []);
  const started = Date.now();
  await assert.rejects(
    () => pin(control, dir, "chat-1", "recording"),
    /No connected browser is named recording/,
  );
  assert.ok(Date.now() - started < 500);
});

test("a worker chat copies the browser its parent chat is pinned to", async () => {
  const control = browser(() => []);
  control.pinChat("parent", "browser-1");
  await pinInherited(control, "/tmp/unused", "child", "parent", undefined);
  assert.equal(control.browserOf("child"), "browser-1");
  await pinInherited(control, "/tmp/unused", "child", "parent", undefined);
  assert.equal(control.browserOf("child"), "browser-1");
});
