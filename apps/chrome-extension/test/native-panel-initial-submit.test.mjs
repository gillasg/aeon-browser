import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
import test from "node:test";

test("own side-panel chat without a tab skips the tab-bound handoff safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-panel-handoff-"));
  const previousChrome = globalThis.chrome;
  try {
    const id = "npcdopokfkpfmepknhoecppgdgmkmihh";
    globalThis.chrome = {
      runtime: { id, getURL: (path) => `chrome-extension://${id}${path}` },
      storage: { session: { get: () => assert.fail("Panel must not read a tab handoff") } },
    };
    const outfile = join(directory, "worker-tabs.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/native-worker-tabs.ts", import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const { takeNativeInitialSubmit } = await import(pathToFileURL(outfile).href);
    const chatId = "00000000-0000-4000-8000-000000000001";
    const sender = { id, url: `chrome-extension://${id}/chat.html?chatId=${chatId}&host=panel` };
    assert.deepEqual(await takeNativeInitialSubmit(sender, chatId), {
      ok: false,
      code: "INITIAL_SUBMIT_UNAVAILABLE",
    });
    assert.deepEqual(await takeNativeInitialSubmit({ ...sender, id: "foreign" }, chatId), {
      ok: false,
      code: "INVALID_SENDER",
    });
    assert.deepEqual(
      await takeNativeInitialSubmit(sender, "00000000-0000-4000-8000-000000000002"),
      {
        ok: false,
        code: "INVALID_SENDER",
      },
    );
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    await rm(directory, { recursive: true, force: true });
  }
});
