import { CoreAttentionRequestSchema } from "@aeon/protocol";
import { WebSocket } from "ws";
import type { CoreAttention } from "./core-attention.js";

export function attachAttentionSocket(socket: WebSocket, attention: CoreAttention): void {
  const unsubscribe = attention.subscribe(() => send(socket, attention.snapshot()));
  const stopAlerts = attention.onAlert((alert) => send(socket, alert));
  socket.once("close", () => {
    unsubscribe();
    stopAlerts();
    attention.disconnect(socket);
  });
}
export function handleAttentionMessage(
  socket: WebSocket,
  candidate: unknown,
  attention?: CoreAttention,
): boolean {
  const request = CoreAttentionRequestSchema.safeParse(candidate);
  if (!request.success || !attention) return false;
  send(socket, attention.handle(socket, request.data));
  return true;
}
function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}
