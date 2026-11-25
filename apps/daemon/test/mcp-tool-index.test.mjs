import assert from "node:assert/strict";
import test from "node:test";
import { McpCodeBridge } from "../dist/mcp-code-bridge.js";
import { assignSlugs, indexServers, listing, searchTools } from "../dist/mcp-tool-index.js";

function managerWith(servers) {
  const calls = [];
  return {
    calls,
    manager: {
      async listMcpTools() {
        return { servers };
      },
      async callMcpTool(serverId, toolName, args) {
        calls.push({ serverId, toolName, args });
        return { isError: false, content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      },
    },
  };
}

const notion = {
  serverId: "cap_9f2a",
  displayName: "Notion",
  tools: [
    {
      name: "create_page",
      description: "Create a page in a database",
      inputSchema: { type: "object", properties: { title: {}, parent: {} } },
    },
    { name: "search", description: "Search pages and databases" },
  ],
};
const github = {
  serverId: "cap_1b7c",
  displayName: "GitHub Issues",
  tools: [
    { name: "create_issue", description: "Open a new issue in a repository" },
    { name: "list_pulls", description: "List pull requests" },
  ],
};

test("mcp.search ranks by tool name, server name and description, honoring limit", async () => {
  const servers = indexServers([notion, github]);
  const top = searchTools(servers, "create page");
  assert.equal(top[0].name, "create_page");
  assert.equal(top[0].slug, "notion");
  assert.deepEqual(top[0].inputKeys, ["title", "parent"]);
  assert.equal(searchTools(servers, "github issue")[0].name, "create_issue");
  assert.equal(searchTools(servers, "pull requests")[0].name, "list_pulls");
  assert.equal(searchTools(servers, "create", 1).length, 1);
  assert.deepEqual(searchTools(servers, "zzz-nothing"), []);
  const bridge = new McpCodeBridge(managerWith([notion, github]).manager);
  const refs = await bridge.search("issue", { limit: 1 });
  assert.deepEqual(refs, [
    {
      server: "github_issues",
      slug: "github_issues",
      name: "create_issue",
      description: "Open a new issue in a repository",
    },
  ]);
});

test("mcp.list caps at 20 tools with per-server counts and a search hint", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `tool_${i}`, description: "x" }));
  const listed = listing(
    indexServers([{ serverId: "cap_big", displayName: "Big", tools: many }, notion]),
  );
  assert.equal(listed.tools.length, 20);
  assert.equal(listed.totalTools, 32);
  assert.equal(listed.truncated, true);
  assert.deepEqual(
    listed.servers.map((s) => [s.server, s.toolCount]),
    [
      ["big", 30],
      ["notion", 2],
    ],
  );
  assert.match(listed.hint, /20 of 32.*mcp\.search\(query\)/);
  assert.ok(!("inputSchema" in listed.tools[0]));
});

test("slugs come from display names, are deterministic, and resolve collisions", () => {
  const slugs = assignSlugs([
    { serverId: "cap_b", displayName: "Notion" },
    { serverId: "cap_a", displayName: "notion!" },
    { serverId: "cap_c", displayName: "Search" },
    { serverId: "cap_d", displayName: "" },
    { serverId: "cap_e", displayName: "3D Tools" },
  ]);
  assert.equal(slugs.get("cap_a"), "notion");
  assert.equal(slugs.get("cap_b"), "notion_2");
  assert.equal(slugs.get("cap_c"), "search_mcp", "never shadows mcp.search");
  assert.equal(slugs.get("cap_d"), "d");
  assert.equal(slugs.get("cap_e"), "s_3d_tools");
});

test("mcp.<slug>.<tool> and mcp.<serverId>.<tool> reach the same server", async () => {
  const { manager, calls } = managerWith([notion, github]);
  const bridge = new McpCodeBridge(manager);
  await bridge.call("notion", "create_page", { title: "a" });
  await bridge.call("cap_9f2a", "create_page", { title: "b" });
  assert.deepEqual(
    calls.map((c) => [c.serverId, c.toolName]),
    [
      ["cap_9f2a", "create_page"],
      ["cap_9f2a", "create_page"],
    ],
  );
  await assert.rejects(bridge.call("notion", "nope", {}), /Closest: .*mcp\.search/);
});
