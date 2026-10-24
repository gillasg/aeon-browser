import { randomUUID } from "node:crypto";
import { CoreBrowserRunRequestSchema, CoreBrowserRunResultSchema } from "@aeon/protocol";
import { sessionChatId } from "@aeon/pi-adapter";
import { WebSocket } from "ws";
import type { BrowserControlService } from "./browser-control-service.js";

// `aeon repl`, and every command that needs the browser, run browser code in the user's Chrome
// through the same executor as browser_code. The CLI gets the cell's own value and output back
// (not the model-facing summary), so it can print exactly what browserkit prints.

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 200_000;

interface Cell {
  value?: unknown;
  output?: string;
  error?: string;
  detail?: string;
}

export function handleBrowserRun(
  socket: WebSocket,
  candidate: unknown,
  browser: BrowserControlService,
): boolean {
  const request = CoreBrowserRunRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId, code, session } = request.data;
  const timeoutMs = request.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chatId = sessionChatId("external", session);
  void browser
    .execute(chatId, `cli-${randomUUID()}`, {
      codeCell: {
        code,
        timeoutMs,
        ownerTitle: "Session · " + session,
        onCall: () => Promise.resolve({ error: "UNSUPPORTED" }),
        onProgress: () => undefined,
      },
    })
    .then(
      (output) => reply(socket, requestId, parseCell(output)),
      (error: unknown) => reply(socket, requestId, { error: messageOf(error) }),
    );
  return true;
}

function parseCell(output: string): Cell {
  try {
    const cell = JSON.parse(output) as Cell;
    return {
      ...(cell.value !== undefined ? { value: cell.value } : {}),
      ...(cell.output ? { output: cell.output.slice(0, MAX_OUTPUT) } : {}),
      ...(cell.error ? { error: cell.error.slice(0, 20_000) } : {}),
      ...(cell.detail ? { detail: cell.detail.slice(0, 20_000) } : {}),
    };
  } catch {
    return { error: "The browser returned an unreadable answer." };
  }
}

function reply(socket: WebSocket, requestId: string, cell: Cell): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify(
      CoreBrowserRunResultSchema.parse({ kind: "core.browser.result", requestId, ...cell }),
    ),
  );
}

export function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 20_000);
}
