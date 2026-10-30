import assert from "node:assert/strict";
import test from "node:test";
import { mapMcpCapabilityToPi, piMcpServerName } from "../dist/mcp-registry-mapping.js";

test("legacy stdio MCP records map to Pi config without materializing credentials", () => {
  const mapped = mapMcpCapabilityToPi(
    {
      id: "cap_docs_server",
      kind: "mcp",
      displayName: "Documentation",
      description: "Read documentation.",
      configReference: "registry",
      credentialReference: "env:DOCS_TOKEN",
      relatedSkillIds: [],
      verification: { state: "needs_check", checkedAt: null, summary: null },
      transport: "stdio",
      command: "docs-mcp",
      args: ["--read-only"],
      endpoint: null,
      workingDirectory: "relative/project",
    },
    "C:/aeon",
  );

  assert.deepEqual(mapped, {
    name: "pippin_docs_server",
    config: {
      type: "stdio",
      command: "docs-mcp",
      args: ["--read-only"],
      cwd: "C:\\aeon\\relative\\project",
      env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
      description: "Documentation: Read documentation.",
      enabled: true,
      exposure: "codemode",
    },
  });
});

test("legacy HTTP MCP records map env authentication and leave external refs disabled", () => {
  prepareMcpRegistryMappingCase1Stage1();
  verifyMcpRegistryMappingCase1Stage2();
  verifyMcpRegistryMappingCase1Stage3();
});

test("legacy MCP capability IDs map to stable Pi names and invalid IDs fail", () => {
  assert.equal(piMcpServerName("cap_catalog"), "pippin_catalog");
  assert.throws(() => piMcpServerName("catalog"), /invalid ID/);
});

function prepareMcpRegistryMappingCase1Stage1() {
  const mapped = mapMcpCapabilityToPi(
    {
      id: "cap_remote_docs",
      kind: "mcp",
      displayName: "Remote documentation",
      description: "Read remote docs.",
      configReference: "registry",
      credentialReference: "env:REMOTE_DOCS_TOKEN",
      relatedSkillIds: [],
      verification: { state: "needs_check", checkedAt: null, summary: null },
      transport: "streamable-http",
      command: null,
      args: [],
      endpoint: "https://example.test/mcp",
      workingDirectory: null,
    },
    "C:/aeon",
  );
  assert.deepEqual(mapped.config, {
    type: "http",
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer ${REMOTE_DOCS_TOKEN}" },
    description: "Remote documentation: Read remote docs.",
    enabled: true,
    exposure: "codemode",
  });
}

function verifyMcpRegistryMappingCase1Stage2() {
  const external = mapMcpCapabilityToPi(
    {
      id: "cap_external_docs",
      kind: "mcp",
      displayName: "External docs",
      description: "Read docs using an external secret source.",
      configReference: "registry",
      credentialReference: "external:keychain-ref",
      relatedSkillIds: [],
      verification: { state: "needs_check", checkedAt: null, summary: null },
      transport: "streamable-http",
      command: null,
      args: [],
      endpoint: "https://example.test/mcp",
      workingDirectory: null,
    },
    "C:/aeon",
  );
  assert.equal(external.config.enabled, false);
  assert.equal(external.warning, "manual-credential-binding-required");
  assert.equal("headers" in external.config, false);
}

function verifyMcpRegistryMappingCase1Stage3() {
  const externalConfigOnly = mapMcpCapabilityToPi(
    {
      id: "cap_external_config_only",
      kind: "mcp",
      displayName: "External config",
      description: "Uses an external config source.",
      configReference: "registry",
      credentialReference: "external-config-only",
      relatedSkillIds: [],
      verification: { state: "needs_check", checkedAt: null, summary: null },
      transport: "streamable-http",
      command: null,
      args: [],
      endpoint: "https://example.test/mcp",
      workingDirectory: null,
    },
    "C:/aeon",
  );
  assert.equal(externalConfigOnly.config.enabled, false);
  assert.equal(externalConfigOnly.warning, "manual-credential-binding-required");
  assert.equal("headers" in externalConfigOnly.config, false);
}
