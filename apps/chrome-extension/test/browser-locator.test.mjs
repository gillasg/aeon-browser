import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

test("browser locators reject ambiguous names and never choose the first matching node", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pippin-browser-locator-"));
  const priorChrome = globalThis.chrome;
  try {
    const outfile = join(directory, "debugger.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/native-browser-debugger.ts", import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const { resolveElement } = await import(pathToFileURL(outfile).href);
    let nodes = [node(1), node(2)];
    const commands = [];
    globalThis.chrome = {
      debugger: {
        sendCommand: async (_debuggee, command) => {
          commands.push(command);
          return { nodes };
        },
      },
    };
    const locator = { kind: "locator", role: "button", name: "Ambiguous target" };
    const resolve = () => resolveElement({ tabId: 1 }, locator, {}, new Map(), new Map());
    await assert.rejects(resolve(), /AMBIGUOUS_TARGET/);
    assert.ok(commands.every((command) => !command.startsWith("Input.")));
    nodes = [node(1), { ...node(2), ignored: true }];
    assert.equal((await resolve()).backendNodeId, 1);
    nodes = [{ ...node(1), name: { value: "Different" } }];
    await assert.rejects(resolve(), /STALE_REF/);
  } finally {
    globalThis.chrome = priorChrome;
    await rm(directory, { recursive: true, force: true });
  }
});

function node(id) {
  return { backendDOMNodeId: id, role: { value: "button" }, name: { value: "Ambiguous target" } };
}
