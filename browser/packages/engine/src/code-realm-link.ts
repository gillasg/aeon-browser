// The extension's end of browser_code realms. The realms run in the local Aeon process (no code
// is evaluated inside the extension); this sends them operations over the socket the extension
// already holds to that process, and serves the browser effects their cells ask for.
import { REALM_EVENT, REALM_EVENT_REPLY, REALM_OP, REALM_OP_REPLY } from "./code-realm-frames.js";

type Waiter = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
// A realm answers every operation; a cell's own deadline (10 minutes at most) answers first. Past
// this, the local process is gone and the cell fails instead of pinning the worker's state.
const OP_MAX_MS = 11 * 60_000;
const pending = new Map<string, Waiter>();
let socket: WebSocket | undefined;
let sequence = 0;

/** The socket realm operations go on: the latest link to the local Aeon process. */
export function bindRealmSocket(next: WebSocket): void {
  socket = next;
}

/** True when the link to the local process is up. */
export function realmLinked(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

/** Sends one realm operation and resolves with the realm's answer. */
export function toRealm(op: Record<string, unknown>, maxMs = OP_MAX_MS): Promise<unknown> {
  const link = socket;
  if (!link || link.readyState !== WebSocket.OPEN)
    return Promise.reject(new Error("BROWSER_OFFLINE: the local Aeon runtime is not connected"));
  const opId = `${Date.now().toString(36)}-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(opId);
      reject(new Error("INTERNAL: browser runtime did not respond; runtime reset"));
    }, maxMs);
    pending.set(opId, { resolve, reject, timer });
    link.send(JSON.stringify({ kind: REALM_OP, opId, op }));
  });
}

/**
 * Handles browser.realm.* frames. `serve` answers one realm event (a call, a stage, a job's end)
 * as the extension answered the offscreen sandbox's messages. Returns false for other frames.
 */
export function handleRealmFrame(
  from: WebSocket,
  candidate: unknown,
  serve: (event: Record<string, unknown>) => Promise<unknown>,
): boolean {
  const frame = candidate as Record<string, unknown> | null;
  if (frame?.kind === REALM_OP_REPLY) {
    const waiter = pending.get(String(frame.opId));
    pending.delete(String(frame.opId));
    if (!waiter) return true;
    clearTimeout(waiter.timer);
    if (typeof frame.error === "string") waiter.reject(new Error(frame.error));
    else waiter.resolve(frame.value);
    return true;
  }
  if (frame?.kind !== REALM_EVENT) return false;
  const eventId = frame.eventId;
  const answer = (body: Record<string, unknown>) => {
    if (from.readyState === WebSocket.OPEN)
      from.send(JSON.stringify({ kind: REALM_EVENT_REPLY, eventId, ...body }));
  };
  serve((frame.event ?? {}) as Record<string, unknown>).then(
    (value) => answer({ value }),
    (error: unknown) => answer({ error: String(error instanceof Error ? error.message : error) }),
  );
  return true;
}
