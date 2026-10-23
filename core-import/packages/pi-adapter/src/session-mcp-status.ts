import type { McpServerStatus } from "@earendil-works/pi-coding-agent";
import type { PiMcpServerStatus, PiSessionHandle } from "@aeon/domain";
export function projectMcpStatuses(servers: readonly McpServerStatus[]): PiMcpServerStatus[] {
  return servers.slice(0, 100).flatMap((server) => {
    const validState =
      server.state === "disabled" ||
      server.state === "starting" ||
      server.state === "connecting" ||
      server.state === "connected" ||
      server.state === "disconnected" ||
      server.state === "needs-auth" ||
      server.state === "failed" ||
      server.state === "closed";
    if (!server.name || !validState) return [];
    return [
      {
        name: server.name.slice(0, 120),
        enabled: server.enabled,
        state: server.state,
        toolCount: boundedCount(server.toolCount),
        resourceCount: boundedCount(server.resourceCount),
      },
    ];
  });
}

function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 10_000) : 0;
}

export async function waitForMcpConnectionState(
  handle: PiSessionHandle,
): Promise<readonly PiMcpServerStatus[]> {
  const deadline = Date.now() + 12_000;
  let statuses = handle.effectiveResources().mcpServers;
  while (
    Date.now() < deadline &&
    statuses.some(({ state }) => state === "starting" || state === "connecting")
  ) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    statuses = handle.effectiveResources().mcpServers;
  }
  return statuses;
}
