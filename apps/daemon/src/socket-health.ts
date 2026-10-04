import { WebSocket } from "ws";
/** Detect half-open local connections; browsers automatically answer protocol pings. */
export function watchSocketHealth(socket: WebSocket): void {
  let lastPong = Date.now();
  socket.on("pong", () => {
    lastPong = Date.now();
  });
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPong > 65000) {
      socket.terminate();
      return;
    }
    socket.ping();
  }, 20000);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
}
