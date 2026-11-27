import { randomUUID } from "node:crypto";
import { CoreBrowserRunRequestSchema, CoreBrowserRunResultSchema } from "@graft/protocol";
import { join } from "node:path";
import {
  cellWorkspaceCall,
  createGraftHostHandler,
  sessionChatId,
  siteMapperRequest,
} from "@graft/pi-adapter";
import { WebSocket } from "ws";
import type { BrowserControlService } from "./browser-control-service.js";
import { pin } from "./core-browsers.js";

// `graft repl`, and every command that needs the browser, run browser code in the user's Chrome
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
  directory: string,
): boolean {
  const request = CoreBrowserRunRequestSchema.safeParse(candidate);
  if (!request.success) return rejectInvalid(socket, candidate, request.error.issues);
  const { requestId, code, session } = request.data;
  const timeoutMs = request.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chatId = sessionChatId("external", session);
  const named = request.data.browser;
  const controller = new AbortController();
  const done = track(socket, browser, chatId, controller);
  void (named ? pin(browser, directory, chatId, named) : Promise.resolve())
    .then(() =>
      browser.execute(
        chatId,
        `cli-${randomUUID()}`,
        {
          codeCell: {
            code,
            timeoutMs,
            ownerTitle: "Session · " + session,
            space: "window",
            onCall: cliCall(chatId, join(directory, "workspaces", chatId)),
            onProgress: () => undefined,
          },
        },
        controller.signal,
      ),
    )
    .then(
      (output) => reply(socket, requestId, parseCell(output)),
      (error: unknown) => reply(socket, requestId, { error: messageOf(error) }),
    )
    .finally(done);
  return true;
}

type Running = { chatId: string; controller: AbortController };
const running = new WeakMap<WebSocket, Set<Running>>();

/**
 * A cell runs only while its client is connected. When `graft repl` is cancelled or its socket
 * drops mid-cell, the cell is cancelled, its realm reset and the session's tabs closed, as a timed-out
 * cell does, instead of driving Chrome for another minute and leaving its tabs open.
 */
function track(
  socket: WebSocket,
  browser: BrowserControlService,
  chatId: string,
  controller: AbortController,
): () => void {
  let cells = running.get(socket);
  if (!cells) {
    const set = new Set<Running>();
    cells = set;
    running.set(socket, set);
    socket.once("close", () => abandon(browser, set));
  }
  const entry = { chatId, controller };
  cells.add(entry);
  return () => void running.get(socket)?.delete(entry);
}

function abandon(browser: BrowserControlService, cells: Set<Running>): void {
  const chats = new Set<string>();
  for (const cell of cells) {
    cell.controller.abort();
    chats.add(cell.chatId);
  }
  cells.clear();
  for (const chatId of chats)
    void browser
      .execute(chatId, `cli-release-${randomUUID()}`, { release: true, reset: true, tidy: true })
      .catch(() => undefined);
}

// A run request the schema refuses still gets an answer naming what was wrong, so the client
// never waits on a frame that was silently dropped.
function rejectInvalid(
  socket: WebSocket,
  candidate: unknown,
  issues: readonly { path: PropertyKey[]; message: string }[],
): boolean {
  const message = candidate as { kind?: unknown; requestId?: unknown } | null;
  if (typeof message !== "object" || message === null || message.kind !== "core.browser.run")
    return false;
  const requestId = message.requestId;
  if (typeof requestId !== "string" || !UUID.test(requestId)) return true;
  const detail = issues
    .map((issue) => `${issue.path.map(String).join(".") || "request"}: ${issue.message}`)
    .join("; ");
  reply(socket, requestId, { error: "INVALID_INPUT", detail });
  return true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What a CLI cell may ask the daemon for: site notes, abilities, site APIs, learned hints and
// sign-ins, as a chat's cells do, plus workspace files and upload checks rooted in the session's
// own workspace folder, so artifact() and page.upload() work from `graft repl` as in a chat.
export function cliCall(chatId: string, workspace: string): (call: unknown) => Promise<unknown> {
  const host = createGraftHostHandler({
    source: "external",
    siteMapper: (request) => siteMapperRequest(chatId, request),
    extra: (request) => cellWorkspaceCall(request, workspace),
  });
  return (call) =>
    host(call, { source: "external", scope: chatId }) ?? Promise.resolve({ error: "UNSUPPORTED" });
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
