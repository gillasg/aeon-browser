/* global AbortController, AbortSignal, setImmediate */
import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserCodeTool } from "../dist/browser-code-tool.js";

// A fake MCP bridge behind browser_code. The tool's onCall is the sandbox -> daemon path; an MCP
// request from a cell must reach the bridge with the cell's signal, and errors must come back.
function fakeBridge(overrides = {}) {
  const state = { calls: [], seenSignal: undefined };
  const bridge = {
    async list(signal) {
      state.seenSignal = signal;
      return [{ name: "cap_wiki.double", description: "Double a number" }];
    },
    async call(server, tool, args, signal) {
      state.calls.push({ server, tool, args });
      state.seenSignal = signal;
      if (overrides.call) return overrides.call(server, tool, args, signal, state);
      if (tool === "boom") throw new Error("tool error: rate limited");
      return args.value * 2;
    },
  };
  return { bridge, state };
}

/**
 * Run a cell whose script loops over three items calling mcp.<server>.<tool>, by driving the
 * cell's onCall the way the sandbox would: an {mcp:...} request for each item and a final value.
 */
async function runCell(tool, mcpRequest) {
  const seen = [];
  const run = async (_chatId, _toolCallId, input) => {
    const cell = input.codeCell;
    for (let n = 1; n <= 3; n++) {
      seen.push(await cell.onCall(mcpRequest(n)));
    }
    return JSON.stringify({ value: seen, output: "" });
  };
  return { run, seen };
}

test("a cell's MCP calls reach the bridge with JSON args, and the loop result comes back", async () => {
  const { bridge, state } = fakeBridge();
  const { run, seen } = await runCell(null, (n) => ({
    mcp: { server: "cap_wiki", tool: "double", args: { value: n } },
  }));
  const tool = createBrowserCodeTool("chat-1", run, undefined, undefined, { mcp: bridge });
  await tool.execute("call-1", {
    code: "for (const n of [1,2,3]) out.push(await mcp.cap_wiki.double({value:n}))",
  });
  assert.deepEqual(seen, [2, 4, 6]);
  assert.deepEqual(state.calls, [
    { server: "cap_wiki", tool: "double", args: { value: 1 } },
    { server: "cap_wiki", tool: "double", args: { value: 2 } },
    { server: "cap_wiki", tool: "double", args: { value: 3 } },
  ]);
});

test("mcp.list() reaches the bridge", async () => {
  const { bridge } = fakeBridge();
  let listed;
  const run = async (_chatId, _toolCallId, input) => {
    listed = await input.codeCell.onCall({ mcp: { list: true } });
    return JSON.stringify({ value: listed, output: "" });
  };
  const tool = createBrowserCodeTool("chat-1", run, undefined, undefined, { mcp: bridge });
  await tool.execute("call-1", { code: "mcp.list()" });
  assert.deepEqual(listed, [{ name: "cap_wiki.double", description: "Double a number" }]);
});

test("mcp.search(q, { limit }) reaches the bridge with the query and limit", async () => {
  const seen = [];
  const bridge = {
    async list() {
      return {};
    },
    async search(query, options) {
      seen.push({ query, options });
      return [{ server: "wiki", slug: "wiki", name: "double", description: "Double" }];
    },
    async call() {},
  };
  let found;
  const run = async (_chatId, _toolCallId, input) => {
    found = await input.codeCell.onCall({ mcp: { search: "double", limit: 2 } });
    return JSON.stringify({ value: found, output: "" });
  };
  const tool = createBrowserCodeTool("chat-1", run, undefined, undefined, { mcp: bridge });
  await tool.execute("call-1", { code: "mcp.search('double', { limit: 2 })" });
  assert.deepEqual(seen, [{ query: "double", options: { limit: 2 } }]);
  assert.equal(found[0].name, "double");
});

test("a tool error propagates out of the cell's onCall", async () => {
  const { bridge } = fakeBridge();
  const run = async (_chatId, _toolCallId, input) => {
    await assert.rejects(
      input.codeCell.onCall({ mcp: { server: "cap_wiki", tool: "boom", args: {} } }),
      /tool error: rate limited/,
    );
    return JSON.stringify({ value: "observed", output: "" });
  };
  const tool = createBrowserCodeTool("chat-1", run, undefined, undefined, { mcp: bridge });
  const result = await tool.execute("call-1", { code: "mcp.cap_wiki.boom({})" });
  assert.match(JSON.stringify(result.content), /observed/);
});

test("cancelling the tool's signal aborts the MCP call's signal, once", async () => {
  let abortInside;
  let attempts = 0;
  const controller = new AbortController();
  const bridge = {
    async list() {
      return [];
    },
    async call(server, tool, args, signal) {
      attempts++;
      assert.ok(signal instanceof AbortSignal, "the cell's signal reaches the MCP call");
      abortInside = new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(signal.aborted), { once: true }),
      );
      if (signal.aborted) return "done";
      return new Promise((resolve) => setImmediate(() => resolve("done")));
    },
  };
  const run = async (_chatId, _toolCallId, input) => {
    const value = await input.codeCell.onCall({
      mcp: { server: "cap_wiki", tool: "double", args: { value: 1 } },
    });
    return JSON.stringify({ value, output: "" });
  };
  const tool = createBrowserCodeTool("chat-1", run, undefined, undefined, { mcp: bridge });
  const pending = tool.execute(
    "call-1",
    { code: "mcp.cap_wiki.double({value:1})" },
    controller.signal,
  );
  controller.abort();
  await pending;
  assert.equal(await abortInside, true, "the in-flight MCP call saw the cancel");
  assert.equal(attempts, 1, "a cancelled call is never retried");
});
