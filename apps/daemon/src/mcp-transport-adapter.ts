import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpCapability } from "@pippin/domain";

export type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

export class McpTransportAdapter {
  create(capability: McpCapability): McpTransport {
    const credential = resolveCredential(capability.credentialReference);
    if (capability.transport === "stdio") {
      const env = getDefaultEnvironment();
      if (credential) env[credential.name] = credential.value;
      return new StdioClientTransport({
        command: capability.command ?? "",
        args: capability.args,
        ...(capability.workingDirectory ? { cwd: capability.workingDirectory } : {}),
        env,
        stderr: "ignore",
        maxBufferSize: 2_000_000,
      });
    }
    const headers = credential ? { Authorization: `Bearer ${credential.value}` } : undefined;
    return new StreamableHTTPClientTransport(new URL(capability.endpoint ?? ""), {
      ...(headers ? { requestInit: { headers } } : {}),
    });
  }
}

function resolveCredential(reference: string | null): { name: string; value: string } | undefined {
  if (!reference || reference === "external-config-only" || reference.startsWith("external:"))
    return undefined;
  const name = reference.slice("env:".length);
  const value = process.env[name];
  if (!value)
    throw new Error("MCP_CREDENTIAL_MISSING: referenced environment credential is unavailable.");
  return { name, value };
}
