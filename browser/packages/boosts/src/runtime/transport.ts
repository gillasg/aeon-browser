// How a running script reaches the service worker.
// - Isolated world: its own long-lived port (userScripts messaging).
// - Page world: DOM events to a small bridge in the isolated world, which owns the port. Page
//   JavaScript can read and forge those events, so the bridge treats every message as the page's
//   own: requests only to the page's origin or the script's declared hosts, nothing else.
import { connectRuleMatches } from "../background/xhr.js";

export type Push = (event: string, data: unknown) => void;

export interface Transport {
  call(op: string, args?: unknown): Promise<unknown>;
  /** Starts a streaming operation; events arrive until "done". Returns a way to cancel it. */
  stream(op: string, args: unknown, onEvent: (event: string, data: unknown) => void): () => void;
  onPush(handler: Push): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onEvent?: (event: string, data: unknown) => void;
}

type Wire =
  | { t: "call"; id: number; op: string; args: unknown; stream?: boolean }
  | { t: "cancel"; id: number }
  | { t: "reply"; id: number; value?: unknown; error?: string }
  | { t: "event"; id: number; event: string; data: unknown }
  | { t: "push"; event: string; data: unknown }
  | { t: "hello" }
  | { t: "ready" };

/** The request bookkeeping both transports share; `post` sends one message up. */
function protocol(post: (message: Wire) => void): Transport & { receive(message: Wire): void } {
  let next = 1;
  const pending = new Map<number, Pending>();
  const pushes: Push[] = [];
  return {
    call(op, args) {
      return new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        post({ t: "call", id, op, args });
      });
    },
    stream(op, args, onEvent) {
      const id = next++;
      pending.set(id, { resolve: () => undefined, reject: () => undefined, onEvent });
      post({ t: "call", id, op, args, stream: true });
      return () => {
        pending.delete(id);
        post({ t: "cancel", id });
      };
    },
    onPush(handler) {
      pushes.push(handler);
    },
    receive(message) {
      if (message.t === "push") for (const handler of pushes) handler(message.event, message.data);
      if (message.t !== "reply" && message.t !== "event") return;
      const entry = pending.get(message.id);
      if (!entry) return;
      if (message.t === "event") {
        entry.onEvent?.(message.event, message.data);
        if (message.event === "done") pending.delete(message.id);
        return;
      }
      pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(message.error));
      else entry.resolve(message.value);
    },
  };
}

/** Isolated world: talk to the service worker over a port, reconnecting after it sleeps. */
export function portTransport(name: string): Transport {
  let port: chrome.runtime.Port | undefined;
  const wire = protocol((message) => connect().postMessage(message));
  function connect(): chrome.runtime.Port {
    if (port) return port;
    const opened = chrome.runtime.connect({ name });
    opened.onMessage.addListener((message: Wire) => wire.receive(message));
    opened.onDisconnect.addListener(() => {
      if (port === opened) port = undefined;
    });
    port = opened;
    return opened;
  }
  connect();
  return wire;
}

const up = (nonce: string): string => `sb-${nonce}-up`;
const down = (nonce: string): string => `sb-${nonce}-down`;

/** Page world: messages go through DOM events to the bridge. Queued until the bridge is ready. */
export function eventTransport(nonce: string): Transport {
  let ready = false;
  const queue: Wire[] = [];
  const emit = (message: Wire): void => {
    document.dispatchEvent(new CustomEvent(up(nonce), { detail: JSON.stringify(message) }));
  };
  const wire = protocol((message) => (ready ? emit(message) : queue.push(message)));
  document.addEventListener(down(nonce), (event) => {
    const message = JSON.parse(String((event as CustomEvent).detail)) as Wire;
    if (message.t === "ready") {
      if (ready) return;
      ready = true;
      for (const queued of queue.splice(0)) emit(queued);
      return;
    }
    wire.receive(message);
  });
  emit({ t: "hello" });
  return wire;
}

/** What a page-world script may reach: its declared @connect rules, else its sites' domains. */
export interface PagePolicy {
  connect: string[];
  sites: string[];
}

/** Calls a page-world script may make. Everything else needs the isolated world. */
const PAGE_OPS = new Set([
  "started",
  "log",
  "health",
  "css.insert",
  "menu.register",
  "menu.unregister",
  "xhr",
  "ws",
  "ws.send",
  "ws.close",
]);

const limited = (op: string): string =>
  `PAGE_WORLD_LIMITED: ${op} needs jsWorld 'isolated' (page JavaScript can reach this script's channel)`;

/** Same origin as the page (for sockets: same host and port), or a host the script declared. */
function reachable(raw: unknown, policy: PagePolicy, socket: boolean): boolean {
  let url: URL;
  try {
    url = new URL(String(raw), location.href);
  } catch {
    return false;
  }
  if (socket ? url.host === location.host : url.origin === location.origin) return true;
  const host = url.hostname;
  if (policy.sites.some((site) => host === site || host.endsWith(`.${site}`))) return true;
  return policy.connect.some(
    (rule) => rule.trim() !== "*" && connectRuleMatches(host, rule, location.hostname),
  );
}

/** Why the bridge refuses a page-world message, or undefined when it may go up. */
export function pageRefusal(message: Wire, policy: PagePolicy): string | undefined {
  if (message.t !== "call") return undefined;
  if (!PAGE_OPS.has(message.op)) return limited(message.op);
  if (message.op !== "xhr" && message.op !== "ws") return undefined;
  const url = (message.args as { url?: unknown } | undefined)?.url;
  if (reachable(url, policy, message.op === "ws")) return undefined;
  return `PAGE_WORLD_LIMITED: a page-world script may only reach its page's own origin or its @connect hosts, not ${String(url)}`;
}

/** The answer to a refused call, in the shape its caller waits for. */
function refusalReplies(message: Extract<Wire, { t: "call" }>, error: string): Wire[] {
  if (!message.stream) return [{ t: "reply", id: message.id, error }];
  const events: [string, unknown][] =
    message.op === "ws"
      ? [
          ["error", { error }],
          ["close", { code: 1006, reason: error, wasClean: false }],
        ]
      : [["error", { status: 0, statusText: "", headers: "", finalUrl: "", mime: "", error }]];
  events.push(["done", undefined]);
  return events.map(([event, data]) => ({ t: "event", id: message.id, event, data }));
}

/** A page may not make the script's own requests follow a redirect to another origin. */
function upward(message: Wire): Wire {
  if (message.t !== "call" || message.op !== "xhr") return message;
  return { ...message, args: { ...(message.args as object), redirect: "error" } };
}

/** The isolated-world half of the page-world transport. */
export function startBridge(nonce: string, name: string, policy: PagePolicy): void {
  let port: chrome.runtime.Port | undefined;
  const toPage = (message: Wire): void => {
    document.dispatchEvent(new CustomEvent(down(nonce), { detail: JSON.stringify(message) }));
  };
  function connect(): chrome.runtime.Port {
    if (port) return port;
    const opened = chrome.runtime.connect({ name });
    opened.onMessage.addListener((message: Wire) => toPage(message));
    opened.onDisconnect.addListener(() => {
      if (port === opened) port = undefined;
    });
    port = opened;
    return opened;
  }
  document.addEventListener(up(nonce), (event) => {
    const message = JSON.parse(String((event as CustomEvent).detail)) as Wire;
    if (message.t === "hello") return toPage({ t: "ready" });
    const refused = pageRefusal(message, policy);
    if (refused && message.t === "call")
      for (const reply of refusalReplies(message, refused)) toPage(reply);
    else connect().postMessage(upward(message));
  });
  connect();
  toPage({ t: "ready" });
}
