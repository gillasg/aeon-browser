// The worker thread that holds every browser_code realm of one browser. A realm stuck in a
// synchronous loop blocks only this thread; the process that owns it terminates and replaces it.
import { parentPort } from "node:worker_threads";
import { RealmHost } from "./code-realm-host.js";
import { hardenHost } from "./code-realm-globals.js";

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const port = parentPort;
if (!port) throw new Error("code-realm-worker runs as a worker thread");
hardenHost();

const waiting = new Map<number, Waiter>();
let sequence = 0;
const host = new RealmHost({
  event: (event) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      waiting.set(id, { resolve, reject });
      port.postMessage({ type: "event", id, event });
    }),
});

// A realm's unhandled rejection is that realm's async error, as a page's unhandledrejection is.
// Nothing else in this thread may reject unhandled; if it does, the thread logs it and goes on.
process.on("unhandledRejection", (reason, promise) => {
  if (!host.noteRejection(promise, reason)) console.error("realm worker:", String(reason));
});

port.on("message", (message: Record<string, unknown>) => {
  if (message.type === "event.reply") {
    const waiter = waiting.get(Number(message.id));
    waiting.delete(Number(message.id));
    if (typeof message.error === "string") waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.value);
    return;
  }
  if (message.type === "events.drop") {
    // The extension link closed: calls in flight fail as they did when the worker went away.
    for (const waiter of waiting.values()) waiter.reject(new Error("Browser host unavailable"));
    waiting.clear();
    return;
  }
  if (message.type !== "op") return;
  const id = message.id;
  Promise.resolve()
    .then(() => host.handle(message.op as Record<string, unknown>))
    .then(
      (value) => port.postMessage({ type: "op.reply", id, value }),
      (error: unknown) => port.postMessage({ type: "op.reply", id, error: String(error) }),
    );
});
