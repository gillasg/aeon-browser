// browser_code exposes the chat's MCP tools as mcp.<server>.<tool>(args), built dynamically in the
// sandbox and routed through __call. A fake host here stands in for the daemon's bridge.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { browserMcpApi } from "../dist/code-api-mcp.js";

function realm(host) {
  const calls = [];
  const context = vm.createContext({
    console,
    __call: (request) => {
      calls.push(request);
      return host(request);
    },
  });
  vm.runInContext(browserMcpApi, context);
  return { context, calls };
}

// A fake MCP server with one doubling tool and one that fails.
function fakeHost() {
  return (request) => {
    const mcp = request.mcp;
    if (mcp.list) return Promise.resolve([{ name: "wiki.double", description: "Double a number" }]);
    if (mcp.server === "wiki" && mcp.tool === "double") return Promise.resolve(mcp.args.value * 2);
    if (mcp.server === "wiki" && mcp.tool === "boom")
      return Promise.reject(new Error("tool failed: rate limited"));
    return Promise.reject(
      new Error(
        `no MCP tool named ${mcp.server}.${mcp.tool}. Available MCP tools: wiki.double, wiki.boom`,
      ),
    );
  };
}

test("a script loops over three items calling one MCP tool in a single cell", async () => {
  const { context, calls } = realm(fakeHost());
  const value = await vm.runInContext(
    `(async () => {
      const items = [1, 2, 3];
      const out = [];
      for (const n of items) out.push(await mcp.wiki.double({value: n}));
      return { out, listed: await mcp.list() };
    })()`,
    context,
  );
  const plain = JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain.out, [2, 4, 6]);
  assert.deepEqual(plain.listed, [{ name: "wiki.double", description: "Double a number" }]);
  assert.equal(calls.length, 4, "three tool calls plus one list, all from one cell");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    mcp: { server: "wiki", tool: "double", args: { value: 1 } },
  });
});

test("a tool error reaches the script with the tool's text", async () => {
  const { context } = realm(fakeHost());
  await assert.rejects(vm.runInContext("mcp.wiki.boom({})", context), /tool failed: rate limited/);
});

test("an unknown tool names what is available", async () => {
  const { context } = realm(fakeHost());
  await assert.rejects(
    vm.runInContext("mcp.wiki.missing({})", context),
    /no MCP tool named wiki\.missing.*wiki\.double/,
  );
});

test("mcp is not a browser tool and cannot call browser_code", async () => {
  const { context, calls } = realm(fakeHost());
  // Accessing a browser tool name still only produces an MCP call; it never reaches a browser step.
  await assert.rejects(vm.runInContext("mcp.browser_code.run({})", context), /no MCP tool named/);
  assert.equal(calls.length, 1);
  assert.ok(!("op" in calls[0].mcp), "the request is an mcp call, not a browser step");
});
