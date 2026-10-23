import { Buffer } from "node:buffer";
import { DaemonUiResponseSchema, type DaemonUiResponse } from "@aeon/protocol";
import { WebSocket } from "ws";

const MAX_OUTBOUND_BYTES = 1_000_000;

export function sendDevChatMessage(socket: WebSocket, candidate: DaemonUiResponse): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const response = DaemonUiResponseSchema.parse(candidate);
  const serialized = JSON.stringify(response);
  if (Buffer.byteLength(serialized) > MAX_OUTBOUND_BYTES) {
    socket.close(1009, "Aeon message exceeds the development frame limit");
    return false;
  }
  socket.send(serialized);
  return true;
}
