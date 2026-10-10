import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import test from "node:test";
import { encodeImageAsset } from "@aeon/protocol";

test("tool image client verifies checksums and cleans up each request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-image-client-"));
  try {
    const outfile = join(directory, "client.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/tool-image-client.ts", import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const { loadToolImage } = await import(pathToFileURL(outfile).href);
    for (const corrupt of [false, true]) {
      const socket = new globalThis.EventTarget();
      const listeners = new Set();
      const bytes = new Uint8Array([1, 2, 3]);
      const client = {
        socket,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        send(request) {
          assert.equal(request.operation, "chat.image");
          assert.equal(request.payload.index, 0);
          const header = {
            kind: "image.asset",
            requestId: request.requestId,
            mimeType: "image/png",
            byteLength: bytes.length,
            checksum: corrupt ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex"),
          };
          globalThis.queueMicrotask(() =>
            socket.dispatchEvent(
              new globalThis.MessageEvent("message", {
                data: new globalThis.Blob([encodeImageAsset(header, bytes)]),
              }),
            ),
          );
        },
      };
      const pending = loadToolImage(client, "00000000-0000-4000-8000-000000000001", "tool-1", 0);
      if (corrupt) await assert.rejects(pending, /checksum mismatch/);
      else {
        const image = await pending;
        assert.equal(image.type, "image/png");
        assert.deepEqual(new Uint8Array(await image.arrayBuffer()), bytes);
      }
      assert.equal(listeners.size, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
