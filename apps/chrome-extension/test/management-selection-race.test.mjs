import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

test("management ignores a slower snapshot for a previously selected thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pippin-management-race-"));
  try {
    const outfile = join(directory, "controller.mjs");
    await build({
      entryPoints: [
        fileURLToPath(new URL("../src/home-management-controller.ts", import.meta.url)),
      ],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const { HomeManagementController } = await import(pathToFileURL(outfile).href);
    const pending = [];
    const client = {
      send: (request) => request.requestId,
      waitFor: (_predicate, requestId) =>
        new Promise((resolve) => pending.push({ requestId, resolve })),
    };
    const controller = new HomeManagementController(
      () => client,
      () => {},
      () => {},
    );
    controller.selectedChatId = "11111111-1111-4111-8111-111111111111";
    const first = controller.load("11111111-1111-4111-8111-111111111111");
    await new Promise((resolve) => setImmediate(resolve));
    controller.selectedChatId = "22222222-2222-4222-8222-222222222222";
    const second = controller.load("22222222-2222-4222-8222-222222222222");
    await new Promise((resolve) => setImmediate(resolve));
    const complete = (index, id) =>
      pending[index].resolve({
        kind: "command.completed",
        result: {
          kind: "management.snapshot",
          snapshot: { chats: [{ chatId: id }], routines: [] },
        },
      });
    complete(1, "22222222-2222-4222-8222-222222222222");
    await second;
    complete(0, "11111111-1111-4111-8111-111111111111");
    await first;
    assert.equal(controller.snapshot.chats[0].chatId, "22222222-2222-4222-8222-222222222222");
    assert.equal(controller.selectedChatId, "22222222-2222-4222-8222-222222222222");
    assert.equal(controller.loading, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
