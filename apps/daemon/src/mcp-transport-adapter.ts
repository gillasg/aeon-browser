import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpCapability } from "@graft/domain";
import { resolveCredentials } from "./mcp-credentials.js";

export type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

export class McpTransportAdapter {
  create(capability: McpCapability): McpTransport {
    const credentials = resolveCredentials(capability.credentialReference);
    if (capability.transport === "stdio") {
      return new StdioClientTransport({
        command: capability.command ?? "",
        args: capability.args,
        ...(capability.workingDirectory ? { cwd: capability.workingDirectory } : {}),
        env: { ...getDefaultEnvironment(), ...credentials.env },
        stderr: "ignore",
        maxBufferSize: 2_000_000,
      });
    }
    const headers = Object.keys(credentials.headers).length ? credentials.headers : undefined;
    return new StreamableHTTPClientTransport(new URL(capability.endpoint ?? ""), {
      ...(headers ? { requestInit: { headers } } : {}),
    });
  }
}
