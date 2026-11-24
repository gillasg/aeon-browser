// The local end of browser_code: the extension sends realm operations (cell, job, interrupt,
// reset, stopJobs) over its existing socket, and the realms run here, in one worker thread per
// process. Every browser effect a cell asks for goes back over the same socket as a realm event,
// and the extension answers it exactly as it answered the offscreen sandbox before.
import { Worker } from "node:worker_threads";
import { REALM_EVENT, REALM_EVENT_REPLY, REALM_OP, REALM_OP_REPLY } from "./code-realm-frames.js";

/** The socket the extension is connected on (a ws WebSocket). */
export interface RealmSocket {
  readonly readyState: number;
  send(text: string): void;
}
const OPEN = 1;
const WORKER_HEAP_MB = 4096;
type Frame = Record<string, unknown>;

export class BrowserRealmServer {
  private worker: Worker | undefined;
  private readonly ops = new Map<number, (reply: Frame) => void>();
  private readonly events = new Map<string, { socket: RealmSocket; workerId: unknown }>();
  /** Which socket asked for a cell or job, so its calls answer on that browser's link. */
  private readonly owners = new Map<string, RealmSocket>();
  private lastSocket: RealmSocket | undefined;
  private opSequence = 0;
  private eventSequence = 0;

  constructor(private readonly workerUrl = new URL("./code-realm-worker.js", import.meta.url)) {}

  /** Handles browser.realm.* frames from the extension. Returns false for anything else. */
  handle(candidate: unknown, socket: RealmSocket): boolean {
    const frame = candidate as Frame | null;
    if (!frame || typeof frame.kind !== "string") return false;
    if (frame.kind === REALM_OP) {
      this.lastSocket = socket;
      void this.op(frame, socket);
      return true;
    }
    if (frame.kind === REALM_EVENT_REPLY) {
      const waiting = this.events.get(String(frame.eventId));
      this.events.delete(String(frame.eventId));
      if (waiting)
        this.worker?.postMessage({
          type: "event.reply",
          id: waiting.workerId,
          ...(typeof frame.error === "string" ? { error: frame.error } : { value: frame.value }),
        });
      return true;
    }
    return false;
  }

  /** A link closed: realm calls waiting on it fail now instead of hanging their cells. */
  socketClosed(socket: RealmSocket): void {
    for (const [eventId, waiting] of this.events)
      if (waiting.socket === socket) {
        this.events.delete(eventId);
        this.worker?.postMessage({
          type: "event.reply",
          id: waiting.workerId,
          error: "Browser host unavailable",
        });
      }
    if (this.lastSocket === socket) this.lastSocket = undefined;
  }

  /** Ends the worker and every realm in it. */
  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.fail(worker, "the browser code runtime was restarted");
    await worker.terminate();
  }

  /** Every operation waiting on this worker answers now; the next one starts a fresh worker. */
  private fail(worker: Worker, reason: string): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const resolve of this.ops.values())
      resolve({ error: `INTERNAL: ${reason}; runtime reset` });
    this.ops.clear();
    this.events.clear();
  }

  private async op(frame: Frame, socket: RealmSocket): Promise<void> {
    const op = (frame.op ?? {}) as Frame;
    const reply = (body: Frame) =>
      send(socket, { kind: REALM_OP_REPLY, opId: frame.opId, ...body });
    if (op.kind === "restart") {
      // The extension's reset found the realms' thread blocked: replace it, as closing the
      // offscreen document did. Every chat's realm in it is already stuck.
      await this.close();
      reply({ value: true });
      return;
    }
    if (op.kind === "cell" && typeof op.cellId === "string") this.owners.set(op.cellId, socket);
    if (op.kind === "job" && typeof op.jobId === "string") this.owners.set(op.jobId, socket);
    const answer = await this.toWorker(op);
    if (op.kind === "cell" && typeof op.cellId === "string") this.owners.delete(op.cellId);
    reply(answer);
  }

  private toWorker(op: Frame): Promise<Frame> {
    const worker = this.ensureWorker();
    const id = ++this.opSequence;
    return new Promise((resolve) => {
      if (this.ops.size === 0) worker.ref();
      this.ops.set(id, resolve);
      worker.postMessage({ type: "op", id, op });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerUrl, {
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    worker.on("message", (message: Frame) => this.fromWorker(worker, message));
    worker.on("error", (error: Error) =>
      this.fail(worker, `the browser code runtime failed (${error.message})`),
    );
    worker.on("exit", () => this.fail(worker, "the browser code runtime stopped"));
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private fromWorker(worker: Worker, message: Frame): void {
    if (message.type === "op.reply") {
      const resolve = this.ops.get(Number(message.id));
      this.ops.delete(Number(message.id));
      if (this.ops.size === 0 && this.worker === worker) worker.unref();
      resolve?.(
        typeof message.error === "string" ? { error: message.error } : { value: message.value },
      );
      return;
    }
    if (message.type !== "event") return;
    const event = (message.event ?? {}) as Frame;
    const key = String(event.jobId ?? event.cellId ?? "");
    const owner = this.owners.get(key);
    const socket = owner?.readyState === OPEN ? owner : this.lastSocket;
    if (event.kind === "jobDone" || event.kind === "jobLost") this.owners.delete(key);
    const eventId = String(++this.eventSequence);
    if (!socket || !send(socket, { kind: REALM_EVENT, eventId, event })) {
      worker.postMessage({
        type: "event.reply",
        id: message.id,
        error: "Browser host unavailable",
      });
      return;
    }
    this.events.set(eventId, { socket, workerId: message.id });
  }
}

function send(socket: RealmSocket, frame: Frame): boolean {
  if (socket.readyState !== OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}
