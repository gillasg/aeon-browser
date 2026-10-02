import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

test("a presentation listener failure cannot strand an already matched command waiter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pippin-ui-waiter-"));
  try {
    const outfile = join(directory, "client.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/dev-ui-client.ts", import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const { DevUiClient } = await import(pathToFileURL(outfile).href);
    const handlers = new Map();
    const socket = {
      addEventListener(kind, handler) {
        handlers.set(kind, handler);
      },
    };
    const client = new DevUiClient(socket);
    client.subscribe(() => {
      throw new Error("presentation failed");
    });
    const response = {
      kind: "command.failed",
      requestId: "00000000-0000-4000-8000-000000000001",
      operation: "chat.image",
      code: "INVALID_COMMAND",
      message: "Image unavailable",
    };
    const result = client.waitFor((message) => message.requestId === response.requestId);
    assert.throws(
      () => handlers.get("message")({ data: JSON.stringify(response) }),
      /presentation failed/,
    );
    assert.deepEqual(await result, response);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
