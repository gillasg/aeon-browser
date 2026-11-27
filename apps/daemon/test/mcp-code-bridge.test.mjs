/* global AbortController, AbortSignal */
import assert from "node:assert/strict";
import test from "node:test";
import { McpCodeBridge } from "../dist/mcp-code-bridge.js";

// A fake MCP server behind the manager: one echo tool that returns JSON, one that reports a tool
// error. The bridge is what browser_code's mcp.* reaches in the daemon.
function fakeManager() {
  const state = { lists: 0, calls: [], lastSignal: undefined };
  const manager = {
    async listMcpTools(serverId, signal) {
      state.lists++;
      state.lastSignal = signal;
      return {
        servers: [
          {
            serverId: "cap_wiki",
            displayName: "Wiki",
            tools: [
              { name: "echo", description: "Echo text\nover two lines" },
              { name: "fail", description: "Fail on purpose" },
            ],
          },
        ],
      };
    },
    async callMcpTool(serverId, toolName, args, signal) {
      state.calls.push({ serverId, toolName, args });
      state.lastSignal = signal;
      if (toolName === "fail")
        return { isError: true, content: [{ type: "text", text: "tool error: quota used" }] };
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify({ echoed: args.text, n: args.n }) }],
      };
    },
  };
  return { manager, state };
}

test("list returns counts and one-line refs under a slug, never Graft's own tools", async () => {
  const { manager } = fakeManager();
  const bridge = new McpCodeBridge(manager);
  const listed = await bridge.list();
  assert.deepEqual(listed.servers, [
    { server: "wiki", serverId: "cap_wiki", displayName: "Wiki", toolCount: 2 },
  ]);
  assert.deepEqual(listed.tools, [
    { server: "wiki", slug: "wiki", name: "echo", description: "Echo text over two lines" },
    { server: "wiki", slug: "wiki", name: "fail", description: "Fail on purpose" },
  ]);
  assert.equal(listed.truncated, false);
  assert.match(listed.hint, /mcp\.search/);
  assert.ok(!listed.tools.some((ref) => /browser_code|browser_tabs|crawl/.test(ref.name)));
});

test("call takes JSON args, returns parsed JSON, and discovers lazily", async () => {
  const { manager, state } = fakeManager();
  const bridge = new McpCodeBridge(manager);
  const value = await bridge.call("cap_wiki", "echo", { text: "hi", n: 3 });
  assert.deepEqual(value, { echoed: "hi", n: 3 });
  assert.equal(state.lists, 1, "one discovery before the first call");
  assert.deepEqual(state.calls, [
    { serverId: "cap_wiki", toolName: "echo", args: { text: "hi", n: 3 } },
  ]);
});

test("a tool error throws into the script with the tool's text", async () => {
  const { manager } = fakeManager();
  const bridge = new McpCodeBridge(manager);
  await assert.rejects(bridge.call("cap_wiki", "fail", {}), /tool error: quota used/);
});

test("an unknown tool throws no MCP tool named X with the available names", async () => {
  const { manager } = fakeManager();
  const bridge = new McpCodeBridge(manager);
  await assert.rejects(
    bridge.call("cap_wiki", "nope", {}),
    /no MCP tool named cap_wiki\.nope.*wiki\.(echo|fail).*mcp\.search/,
  );
});

test("the run's signal reaches the MCP call, and a cancelled call is not retried", async () => {
  const { manager, state } = fakeManager();
  const bridge = new McpCodeBridge(manager);
  const controller = new AbortController();
  const pending = bridge.call("cap_wiki", "echo", { text: "x" }, controller.signal);
  assert.ok(state.lastSignal instanceof AbortSignal, "a signal reached the manager");
  controller.abort();
  assert.equal(state.lastSignal.aborted, true, "cancelling the run aborts the MCP request");
  await pending;
  assert.equal(state.calls.length, 1, "one attempt only, never replayed after cancel");
});

test("a server connected after the first listing is found by one fresh listing", async () => {
  const { manager, state } = fakeManager();
  const original = manager.listMcpTools.bind(manager);
  let connected = false;
  manager.listMcpTools = async (serverId, signal) => {
    const reply = await original(serverId, signal);
    if (connected)
      reply.servers.push({ serverId: "cap_late", tools: [{ name: "echo", description: "Late" }] });
    return reply;
  };
  const bridge = new McpCodeBridge(manager);
  await bridge.list();
  connected = true;
  const value = await bridge.call("cap_late", "echo", { text: "late", n: 1 });
  assert.deepEqual(value, { echoed: "late", n: 1 });
  assert.equal(state.lists, 2);
  await assert.rejects(bridge.call("cap_none", "echo", {}), /no MCP tool named cap_none\.echo/);
});

test("a JSON result with a warning block stays a JSON object, the warning in its own field", async () => {
  const manager = {
    async listMcpTools() {
      return {
        servers: [{ serverId: "cap_wiki", displayName: "Wiki", tools: [{ name: "echo" }] }],
      };
    },
    async callMcpTool() {
      return {
        isError: false,
        content: [
          { type: "text", text: JSON.stringify({ rows: [1, 2], next: "c2" }) },
          { type: "text", text: "Warning: results limited to 2" },
        ],
      };
    },
  };
  const value = await new McpCodeBridge(manager).call("cap_wiki", "echo", {});
  assert.equal(typeof value, "object");
  assert.deepEqual(value.rows, [1, 2]);
  assert.equal(value.next, "c2");
  assert.deepEqual(value.warnings, ["Warning: results limited to 2"]);
});
