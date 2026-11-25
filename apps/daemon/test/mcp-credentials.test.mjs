import assert from "node:assert/strict";
import test from "node:test";
import { parseCredentialBindings, resolveCredentials } from "../dist/mcp-credentials.js";
import { parseCapability } from "../dist/capability-parsing.js";
import { mapMcpCapabilityToPi } from "../dist/mcp-registry-mapping.js";

test("env:<VAR> stays a bearer token; header:<Name>=env:<VAR> sends that header", () => {
  const env = { TOKEN: "t1", MY_API_KEY: "k1", ORG: "o1" };
  assert.deepEqual(resolveCredentials("env:TOKEN", env).headers, { Authorization: "Bearer t1" });
  const resolved = resolveCredentials("header:x-api-key=env:MY_API_KEY,header:X-Org=env:ORG", env);
  assert.deepEqual(resolved.headers, { "x-api-key": "k1", "X-Org": "o1" });
  assert.deepEqual(resolved.env, { MY_API_KEY: "k1", ORG: "o1" });
  assert.deepEqual(resolveCredentials("external:vault", env), { env: {}, headers: {} });
});

test("malformed header names and missing variables are refused clearly", () => {
  for (const bad of [
    "header:x-api\r\nkey=env:K",
    "header:x api=env:K",
    "header:=env:K",
    "header:x-api-key=K",
    "header:x-api-key=env:1BAD",
    "header:a=env:K,header:A=env:J",
  ])
    assert.throws(() => parseCredentialBindings(bad), /MCP_CREDENTIAL_INVALID/, bad);
  assert.throws(
    () => resolveCredentials("header:x-api-key=env:NOPE", {}),
    /MCP_CREDENTIAL_MISSING: environment variable NOPE/,
  );
  assert.throws(
    () => resolveCredentials("header:x-api-key=env:K", { K: "a\r\nInjected: 1" }),
    /MCP_CREDENTIAL_INVALID/,
  );
});

test("the registry accepts header references and Pi mapping keeps them as references", () => {
  const capability = parseCapability({
    id: "cap_api",
    kind: "mcp",
    displayName: "API",
    description: "An API.",
    configReference: "test",
    credentialReference: "header:x-api-key=env:MY_API_KEY",
    relatedSkillIds: [],
    transport: "streamable-http",
    endpoint: "https://example.com/mcp",
  });
  assert.deepEqual(mapMcpCapabilityToPi(capability, "/tmp").config.headers, {
    "x-api-key": "$" + "{MY_API_KEY}",
  });
  assert.throws(
    () => parseCapability({ ...capability, credentialReference: "header:bad name=env:X" }),
    /credentialReference/,
  );
});
