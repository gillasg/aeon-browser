import {
  CoreHealthRequestSchema,
  CoreHealthResultSchema,
  SUPPORTED_PROTOCOL_VERSION,
} from "@aeon/protocol";
import { WebSocket } from "ws";
import type { BrowserControlService } from "./browser-control-service.js";
import type { HealthReport } from "./health-ping.js";

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
