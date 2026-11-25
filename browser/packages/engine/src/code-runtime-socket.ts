// Frames from the code runtime to the bridge socket.

// The bridge accepts frames up to 32 MB. A cell that returns more is refused here so the failure
// is its own message (a result drops its value, a call fails alone) instead of a closed socket.
const MAX_MESSAGE_CHARS = 24_000_000;
export function sendToBridge(socket: WebSocket, message: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  let text = JSON.stringify(message);
  const limit = MAX_MESSAGE_CHARS;
  if (text.length > limit) {
    const result = message as { kind?: string; value?: unknown; steps?: unknown[] };
    if (result.kind !== "browser.code.result") return false;
    const size = (text.length / 1_000_000).toFixed(1);
    text = JSON.stringify({
      ...result,
      value: undefined,
      steps: [],
      output: "",
      error: `RESULT_TOO_LARGE: the result was ${size} MB. Return less, or write it with artifact(name, data) and return a summary.`,
    });
  }
  socket.send(text);
  return true;
}
