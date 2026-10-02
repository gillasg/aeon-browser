import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
import test from "node:test";

test("first prompt waits for native Pi setup and applies model before effort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pippin-initial-selection-"));
  try {
    const outfile = join(directory, "selection.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/initial-chat-selection.ts", import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
    });
    const { applyInitialChatSelection } = await import(pathToFileURL(outfile).href);
    const sent = [];
    const client = {
      send(request) {
        sent.push(request);
        return sent.length;
      },
      async waitFor(predicate, after, timeout) {
        assert.equal(after, sent.length);
        assert.equal(timeout, 60_000);
        const request = sent.at(-1);
        const reply = { kind: "command.completed", requestId: request.requestId };
        assert.equal(predicate(reply), true);
        assert.equal(predicate({ ...reply, requestId: "wrong" }), false);
        return reply;
      },
    };
    await applyInitialChatSelection(client, "00000000-0000-4000-8000-000000000001", {
      model: { provider: "openai-codex", id: "gpt-6-luna" },
      thinkingLevel: "low",
    });
    assert.deepEqual(
      sent.map((request) => request.operation),
      ["chat.model", "chat.thinking"],
    );
    assert.equal(sent[1].payload.level, "low");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
