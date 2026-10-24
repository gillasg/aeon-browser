import { randomUUID } from "node:crypto";
import {
  CoreBlockedSitesRequestSchema,
  CoreBlockedSitesResultSchema,
  NativeBlockedSitesReplySchema,
  NativeBlockedSitesRequestSchema,
} from "@aeon/protocol";
import { WebSocket } from "ws";
import type { BrowserControlService } from "./browser-control-service.js";
import { messageOf } from "./core-browser.js";

// `aeon block|unblock|blocked`: the list lives in the extension (settings → Blocked sites), so
// Core relays reads and changes to every connected Chrome, exactly like `aeon settings`. Only the
// user runs these commands; no chat tool or agent-written code reaches this message.

const TIMEOUT_MS = 5000;
const waiting = new Map<string, (answer: { sites: string[]; error?: string }) => void>();

export function handleBlockedSites(
  socket: WebSocket,
  candidate: unknown,
  browser: BrowserControlService,
): boolean {
  const request = CoreBlockedSitesRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId, action, site } = request.data;
  void relay(browser.executorSockets(), { action, ...(site ? { site } : {}) }).then(
    (answers) => {
      const failure = answers.find((answer) => answer.error);
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify(
          CoreBlockedSitesResultSchema.parse({
            kind: "core.blocked-sites.result",
            requestId,
            sites: merge(answers),
            ...(failure?.error ? { error: failure.error } : {}),
          }),
        ),
      );
    },
    (error: unknown) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(
        JSON.stringify(
          CoreBlockedSitesResultSchema.parse({
            kind: "core.blocked-sites.result",
            requestId,
            sites: [],
            error: messageOf(error),
          }),
        ),
      );
    },
  );
  return true;
}

/** The extension's answer to a relayed request (one per connected Chrome). */
export function handleBlockedSitesReply(candidate: unknown): boolean {
  const reply = NativeBlockedSitesReplySchema.safeParse(candidate);
  if (!reply.success) return false;
  waiting.get(reply.data.requestId)?.({
    sites: reply.data.sites,
    ...(reply.data.error ? { error: reply.data.error } : {}),
  });
  return true;
}

async function relay(
  sockets: WebSocket[],
  body: { action: "read" | "add" | "remove"; site?: string },
): Promise<{ sites: string[]; error?: string }[]> {
  const open = sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
  if (!open.length) throw new Error("No connected Chrome has Aeon loaded.");
  return Promise.all(open.map((socket) => ask(socket, body)));
}

function ask(
  socket: WebSocket,
  body: { action: "read" | "add" | "remove"; site?: string },
): Promise<{ sites: string[]; error?: string }> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      resolve({ sites: [], error: "Chrome did not answer; reload Aeon and retry." });
    }, TIMEOUT_MS);
    waiting.set(requestId, (answer) => {
      clearTimeout(timer);
      waiting.delete(requestId);
      resolve(answer);
    });
    socket.send(
      JSON.stringify(
        NativeBlockedSitesRequestSchema.parse({ kind: "native.blocked-sites", requestId, ...body }),
      ),
    );
  });
}

/** Every browser keeps its own list; the answer is what the user blocks anywhere. */
function merge(answers: { sites: string[] }[]): string[] {
  return [...new Set(answers.flatMap((answer) => answer.sites))].sort();
}
