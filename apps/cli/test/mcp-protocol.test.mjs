import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_META_CLIENT,
  MCP_META_VERSION,
  MCP_MODERN_VERSION,
  MCP_SESSION_META,
  chooseMcpSession,
  isModernMcp,
  mcpClientName,
  mcpDiscoverResult,
  mcpListResult,
  mcpResult,
  mcpSessionFromMeta,
} from "@graft/protocol";

test("2026-07-28 is detected from _meta, and server/discover probes the modern era", () => {
  assert.equal(
    isModernMcp("tools/call", { _meta: { [MCP_META_VERSION]: MCP_MODERN_VERSION } }),
    true,
  );
  assert.equal(isModernMcp("server/discover", {}), true);
  assert.equal(isModernMcp("tools/call", {}), false, "an old-style call keeps the old shape");
  assert.equal(
    isModernMcp("initialize", { _meta: { [MCP_META_VERSION]: MCP_MODERN_VERSION } }),
    true,
  );
});

test("server/discover reports supported versions, capabilities and the server in _meta", () => {
  const result = mcpDiscoverResult({ name: "graft", version: "0.1.0" }, undefined, {
    tools: { listChanged: false },
  });
  assert.equal(result.resultType, "complete");
  assert.ok(result.supportedVersions.includes(MCP_MODERN_VERSION));
  assert.ok(result.supportedVersions.includes("2025-06-18"), "older versions still work");
  assert.equal(result.ttlMs, 0);
  assert.equal(result.cacheScope, "private");
  assert.equal(result.capabilities.tools.listChanged, false);
  assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "graft");
});

test("modern list and call results carry resultType; older ones do not", () => {
  assert.deepEqual(mcpListResult({ tools: [] }, true), {
    tools: [],
    resultType: "complete",
    ttlMs: 0,
    cacheScope: "private",
  });
  assert.deepEqual(mcpListResult({ tools: [] }, false), { tools: [] });
  assert.deepEqual(mcpResult({ content: [], isError: false }, true), {
    content: [],
    isError: false,
    resultType: "complete",
  });
  assert.deepEqual(mcpResult({ content: [] }, false), { content: [] });
});

test("the caller's session id comes from ai.opencode/sessionID in _meta", () => {
  const params = { _meta: { [MCP_SESSION_META]: "agent-42" } };
  assert.equal(mcpSessionFromMeta(params), "agent-42");
  assert.equal(mcpSessionFromMeta({}), undefined);
  assert.equal(mcpClientName({ _meta: { [MCP_META_CLIENT]: { name: "opencode" } } }), "opencode");
});

test("an explicit session wins over the caller's default", () => {
  assert.equal(chooseMcpSession("my-session", "agent-42"), "my-session");
  assert.equal(chooseMcpSession(undefined, "agent-42"), "agent-42");
  assert.equal(chooseMcpSession("", "agent-42"), "agent-42");
  assert.equal(
    chooseMcpSession(undefined, undefined),
    "mcp",
    "older clients keep the legacy default",
  );
});
