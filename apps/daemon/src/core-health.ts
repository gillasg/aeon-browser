import {
  CoreHealthRequestSchema,
  CoreHealthResultSchema,
  CorePingRequestSchema,
  CorePingResultSchema,
  SUPPORTED_PROTOCOL_VERSION,
} from "@aeon/protocol";
import { WebSocket } from "ws";
import type { BrowserControlService } from "./browser-control-service.js";
import type { HealthReport } from "./health-ping.js";

/** The event loop answers this itself. A blocked loop cannot, which is the point. */
export function handleCorePing(socket: WebSocket, candidate: unknown): boolean {
  const request = CorePingRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  if (socket.readyState !== WebSocket.OPEN) return true;
  socket.send(
    JSON.stringify(
      CorePingResultSchema.parse({
        kind: "core.ping.result",
        requestId: request.data.requestId,
        ok: true,
      }),
    ),
  );
  return true;
}

/** `aeon doctor` and any other core client: the same ping the supervisor sends. */
export function handleCoreHealth(
  socket: WebSocket,
  candidate: unknown,
  browser: BrowserControlService,
): boolean {
  const request = CoreHealthRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId } = request.data;
  void browser.pingHealth().then(
    (report) => send(socket, requestId, report),
    () => send(socket, requestId, missed()),
  );
  return true;
}

function send(socket: WebSocket, requestId: string, report: HealthReport): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(CoreHealthResultSchema.parse(healthResult(requestId, report))));
}

function healthResult(requestId: string, report: HealthReport): Record<string, unknown> {
  return {
    kind: "core.health.result",
    requestId,
    ok: report.ok,
    daemon: report.daemon,
    extension: report.extension,
    engine: report.engine,
    protocolVersion: report.protocolVersion,
    ms: report.ms,
    ...(report.engineProtocol ? { engineProtocol: report.engineProtocol } : {}),
    ...(report.cdpFailures?.length ? { cdpFailures: report.cdpFailures } : {}),
  };
}

function missed(): HealthReport {
  return {
    ok: false,
    daemon: true,
    extension: false,
    engine: false,
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    ms: 0,
  };
}
