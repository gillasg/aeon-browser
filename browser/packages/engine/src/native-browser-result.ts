// The failure the engine sends back: the shared code, and the one call to run next when one is safe.
import {
  BrowserOperationResultSchema,
  failureNextCall,
  wireErrorCode,
  type BrowserExecutorRequest,
} from "@browserkit/protocol";
import { completeBrowserRequest } from "./native-browser-session.js";

export function sendFailure(
  socket: WebSocket,
  request: BrowserExecutorRequest,
  code: string,
  detail?: string,
): void {
  completeBrowserRequest(request);
  if (socket.readyState !== WebSocket.OPEN) return;
  // The real code travels with its own hint and next step; only a code no one knows is Chrome's.
  const safe = wireErrorCode(code);
  const next = failureNextCall(safe, detail);
  socket.send(
    JSON.stringify(
      BrowserOperationResultSchema.parse({
        kind: "browser.operation.result",
        requestId: request.requestId,
        operationId: request.operationId,
        ok: false,
        code: safe,
        ...(detail ? { detail } : {}),
        ...(next ? { next } : {}),
      }),
    ),
  );
}

export function respondFailure(
  socket: WebSocket,
  request: BrowserExecutorRequest,
  code: string,
): true {
  sendFailure(socket, request, code);
  return true;
}
