import { WebSocket } from "ws";
import type { BrowserControlService } from "./browser-control-service.js";

// `aeon cdp`: the daemon's Core endpoint starts, reports or stops the local DevTools endpoint.
// The server itself lives in @browserkit/cdp; this command only reaches the browser control
// service, which sends every page command down the executor socket the extension already uses.
export function handleCdpRequest(
  socket: WebSocket,
  candidate: unknown,
  browser: BrowserControlService,
  directory: string,
): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  const request = candidate as {
    kind?: unknown;
    requestId?: unknown;
    action?: unknown;
    port?: unknown;
  };
  if (request.kind !== "core.cdp") return false;
  const requestId = String(request.requestId ?? "");
  const action = String(request.action ?? "start");
  const reply = (body: Record<string, unknown>) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ kind: "core.cdp.result", requestId, ...body }));
  };
  const run =
    action === "status"
      ? browser.cdpStatus()
      : action === "stop"
        ? browser.stopCdp()
        : browser.startCdp(Number(request.port ?? 9333), directory);
  void run.then(
    (result) => reply({ ...(result as Record<string, unknown>) }),
    (error: unknown) =>
      reply({ running: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
}
