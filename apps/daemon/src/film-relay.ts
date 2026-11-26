import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { CoreFilmRequestSchema, NativeFilmReplySchema, type FilmAction } from "@aeon/protocol";

// `aeon record`: the beat bus lives in each Chrome's chrome.storage.session, which only the
// extension's own pages and worker can reach. Core relays arm/read/clear to every connected
// Chrome and merges what comes back.
type FilmReply = { ok: boolean; beats: Record<string, unknown>[] };
const waiting = new Map<string, (reply: FilmReply) => void>();

export async function relayFilm(
  sockets: WebSocket[],
  action: FilmAction,
  timeoutMs = 5000,
): Promise<FilmReply> {
  const open = sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
  const replies = (await Promise.all(open.map((s) => ask(s, action, timeoutMs)))).filter(
    (reply): reply is FilmReply => reply !== undefined,
  );
  return {
    ok: replies.some((reply) => reply.ok),
    beats: replies.flatMap((reply) => reply.beats),
  };
}

function ask(socket: WebSocket, action: FilmAction, timeoutMs: number) {
  const requestId = randomUUID();
  return new Promise<FilmReply | undefined>((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      resolve(undefined);
    }, timeoutMs);
    waiting.set(requestId, (reply) => {
      clearTimeout(timer);
      waiting.delete(requestId);
      resolve(reply);
    });
    socket.send(JSON.stringify({ kind: "native.film", requestId, action }));
  });
}

export function handleFilmReply(candidate: unknown): boolean {
  const reply = NativeFilmReplySchema.safeParse(candidate);
  if (!reply.success) return false;
  waiting.get(reply.data.requestId)?.({ ok: reply.data.ok, beats: reply.data.beats });
  return true;
}

/** A local client's `core.film`: answered with `core.film.result` once every Chrome replies. */
export function handleCoreFilm(
  socket: WebSocket,
  candidate: unknown,
  executorSockets: () => WebSocket[],
): boolean {
  const request = CoreFilmRequestSchema.safeParse(candidate);
  if (!request.success) return false;
  const { requestId, action } = request.data;
  void relayFilm(executorSockets(), action).then((reply) =>
    socket.send(JSON.stringify({ kind: "core.film.result", requestId, ...reply })),
  );
  return true;
}
