import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

test("browser locators reject ambiguous names and never choose the first matching node", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-browser-locator-"));
  const priorChrome = globalThis.chrome;
  try {
    const outfile = join(directory, "debugger.mjs");
    await build({
      entryPoints: [
        fileURLToPath(
          new URL(
            "../node_modules/@browserkit/engine/src/native-browser-debugger.ts",
            import.meta.url,
          ),
        ),
      ],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
    });

    let nodes = [node(1), node(2)];
    const commands = [];
    const event = { addListener() {} };
    globalThis.chrome = {
      tabs: { onRemoved: event },
      debugger: {
        onDetach: event,
        onEvent: event,
        sendCommand: async (_debuggee, command) => {
          commands.push(command);
          if (command === "DOM.resolveNode") return { object: { objectId: "node" } };
          if (command === "Runtime.callFunctionOn") return { result: { value: { visible: true } } };
          return { nodes };
        },
      },
    };
    const { resolveElement } = await import(pathToFileURL(outfile).href);
    const locator = { kind: "locator", role: "button", name: "Ambiguous target" };
    const resolve = () => resolveElement({ tabId: 1 }, locator, {}, new Map(), new Map());
    await assert.rejects(resolve(), /AMBIGUOUS_TARGET/);
    assert.ok(commands.every((command) => !command.startsWith("Input.")));
    nodes = [node(1), { ...node(2), ignored: true }];
    assert.equal((await resolve()).backendNodeId, 1);
    nodes = [{ ...node(1), name: { value: "Different" } }];
    await assert.rejects(resolve(), /TARGET_NOT_FOUND/);
  } finally {
    globalThis.chrome = priorChrome;
    await rm(directory, { recursive: true, force: true });
  }
});

function node(id) {
  return { backendDOMNodeId: id, role: { value: "button" }, name: { value: "Ambiguous target" } };
}
