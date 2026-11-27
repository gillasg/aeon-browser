import { mayConnect } from "./xhr.js";

// GM.webSocket in the service worker: a live socket to any host the script may @connect to,
// opened outside the page so its connect-src policy does not apply. Frames stream back as events.

export interface SocketArgs {
  /** The page's own handle for this socket. */
  sid: string;
  url: string;
  protocols?: string | string[];
}

export interface SocketOwner {
  /** Whether the script is a boost (any host) or a userscript limited to its @connect list. */
  connect: string[] | undefined;
  pageUrl?: string;
  /** The hosts of the script's own sites: its reach when it has no @connect list. */
  sites?: string[];
}

type Emit = (event: string, data?: unknown) => void;

export type SocketData = string | { kind: "bytes"; base64: string };

/** The most sockets one running script may hold open at once. */
export const MAX_SOCKETS = 8;

interface Open {
  socket: WebSocket;
  emit: Emit;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Why a script may not open this socket, or undefined when it may. */
export function socketRefusal(url: string, owner: SocketOwner): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Not a URL: ${url}`;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
    return `Only ws: and wss: sockets are allowed, not ${parsed.protocol}`;
  if (!mayConnect(url, owner.pageUrl, owner.connect, owner.sites))
    return `This script may not connect to ${parsed.hostname}: add it to @connect`;
  return undefined;
}

function frame(data: unknown): SocketData {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return { kind: "bytes", base64: toBase64(new Uint8Array(data)) };
  if (ArrayBuffer.isView(data))
    return {
      kind: "bytes",
      base64: toBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    };
  return String(data);
}

function wire(socket: WebSocket, emit: Emit, forget: () => void): void {
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => emit("open", { protocol: socket.protocol }));
  socket.addEventListener("message", (event) => emit("message", { data: frame(event.data) }));
  socket.addEventListener("error", () => emit("error", { error: "WebSocket error" }));
  socket.addEventListener("close", (event) => {
    forget();
    emit("close", { code: event.code, reason: event.reason, wasClean: event.wasClean });
    emit("done");
  });
}

/** The sockets of every running script, by the script's port (or any owner key). */
export interface SocketHub {
  open(key: object, owner: SocketOwner, args: SocketArgs, emit: Emit): void;
  send(key: object, sid: string, data: SocketData): void;
  close(key: object, sid: string, code?: number, reason?: string): void;
  /** Closes every socket a script holds (its page went away or it stopped). */
  release(key: object): void;
  count(key: object): number;
}

export function socketHub(limit = MAX_SOCKETS): SocketHub {
  const owners = new Map<object, Map<string, Open>>();
  const listFor = (key: object): Map<string, Open> => {
    const list = owners.get(key) ?? new Map<string, Open>();
    owners.set(key, list);
    return list;
  };
  const fail = (emit: Emit, error: string): void => {
    emit("error", { error });
    emit("close", { code: 1006, reason: error, wasClean: false });
    emit("done");
  };
  return {
    open(key: object, owner: SocketOwner, args: SocketArgs, emit: Emit): void {
      const refusal = socketRefusal(String(args.url), owner);
      if (refusal) return fail(emit, refusal);
      const list = listFor(key);
      if (list.size >= limit) return fail(emit, `A script may hold at most ${limit} sockets open`);
      let socket: WebSocket;
      try {
        socket = new WebSocket(args.url, args.protocols);
      } catch (error) {
        return fail(emit, error instanceof Error ? error.message : String(error));
      }
      list.set(args.sid, { socket, emit });
      wire(socket, emit, () => list.delete(args.sid));
    },
    send(key: object, sid: string, data: SocketData): void {
      const open = owners.get(key)?.get(sid);
      if (!open) throw new Error("That socket is closed");
      open.socket.send(typeof data === "string" ? data : fromBase64(data.base64));
    },
    close(key: object, sid: string, code?: number, reason?: string): void {
      const open = owners.get(key)?.get(sid);
      if (!open) return;
      // Browsers accept only 1000 and 3000-4999 from a page.
      const valid = code === undefined || code === 1000 || (code >= 3000 && code <= 4999);
      if (!valid) throw new Error(`Close codes are 1000 or 3000-4999, not ${code}`);
      open.socket.close(code, reason);
    },
    release(key: object): void {
      const list = owners.get(key);
      owners.delete(key);
      for (const { socket } of list?.values() ?? []) socket.close(1000, "The script stopped");
    },
    count(key: object): number {
      return owners.get(key)?.size ?? 0;
    },
  };
}
