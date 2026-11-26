import type { Transport } from "./transport.js";

// GM.webSocket: a live socket opened by the service worker, so the page's connect-src does not
// apply. Text frames arrive as strings, binary ones as ArrayBuffers.

export interface WebSocketDetails {
  url: string;
  protocols?: string | string[];
  onopen?: (event: { protocol: string }) => void;
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  onerror?: (event: { error: string }) => void;
  onclose?: (event: { code: number; reason: string; wasClean: boolean }) => void;
}

export interface WebSocketHandle {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

type Wire = string | { kind: "bytes"; base64: string };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function decode(data: Wire): string | ArrayBuffer {
  if (typeof data === "string") return data;
  return Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0)).buffer;
}

function encode(data: string | ArrayBuffer | Uint8Array): Wire {
  if (typeof data === "string") return data;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return { kind: "bytes", base64: toBase64(bytes) };
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export function webSocket(
  transport: Transport,
  details: WebSocketDetails,
  report: (error: unknown) => void,
): WebSocketHandle {
  const sid = crypto.randomUUID();
  let state = CONNECTING;
  const fire = <T>(handler: ((event: T) => void) | undefined, event: T): void => {
    try {
      handler?.(event);
    } catch (error) {
      report(error);
    }
  };
  transport.stream("ws", { sid, url: details.url, protocols: details.protocols }, (event, data) => {
    const payload = (data ?? {}) as Record<string, unknown>;
    if (event === "open") {
      state = OPEN;
      fire(details.onopen, { protocol: String(payload.protocol ?? "") });
    } else if (event === "message") fire(details.onmessage, { data: decode(payload.data as Wire) });
    else if (event === "error") fire(details.onerror, { error: String(payload.error ?? "error") });
    else if (event === "close") {
      state = CLOSED;
      fire(details.onclose, {
        code: Number(payload.code ?? 1006),
        reason: String(payload.reason ?? ""),
        wasClean: payload.wasClean === true,
      });
    }
  });
  return {
    send(data) {
      if (state !== OPEN) throw new Error("The socket is not open");
      transport.call("ws.send", { sid, data: encode(data) }).catch(report);
    },
    close(code, reason) {
      if (state === CLOSED) return;
      state = CLOSING;
      transport.call("ws.close", { sid, code, reason }).catch(report);
    },
    get readyState() {
      return state;
    },
  };
}
