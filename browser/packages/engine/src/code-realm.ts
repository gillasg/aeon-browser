// One chat's browser_code realm, run by the local Graft process in an isolated vm context. No
// extension API and no Node API is inside; every browser or workspace request is posted to the
// host, which relays it to the extension (browser effects) or answers it itself.
import vm from "node:vm";
import { toReplScript } from "./code-repl.js";
import {
  abilityRepairCall,
  ABILITY_REPAIR_HINT,
  errorHint,
  errorNextCall,
  leadingCode,
  nameModelCodeError,
} from "@browserkit/protocol";
import { realmRuntimeSource } from "./code-realm-source.js";
import { clearRealmTimers, createRealmContext, type RealmTimers } from "./code-realm-globals.js";
import { encodeBytes, formatValue, portable } from "./code-realm-values.js";

/** What a realm posts to its host: the same messages the sandbox page posted to its parent. */
export type RealmPost = (message: Record<string, unknown>) => void;
/** A pending call's realm callbacks: the answer crosses as JSON text, the failure as its message. */
type Waiter = { resolve: (json: string | undefined) => void; reject: (message: string) => void };

const CELL_SYNC_MS = 10 * 60_000;
const messageOf = (error: unknown): string =>
  error !== null && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);

export class CodeRealm {
  private readonly context: vm.Context;
  private readonly scope: Record<string, unknown>;
  private readonly promiseProto: object;
  private readonly runtimeGlobals: Set<string>;
  private readonly timers: RealmTimers = { timeouts: new Set(), intervals: new Set() };
  private readonly pending = new Map<string, Waiter>();
  private cellId = "";
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private output = "";
  private asynchronousError: string | undefined;
  private stopped = false;
  private keep = false;
  private disposed = false;

  constructor(private readonly post: RealmPost) {
    this.context = createRealmContext(this.timers);
    this.scope = this.context as Record<string, unknown>;
    this.promiseProto = this.evaluate("Promise.prototype") as object;
    this.install();
    realmRuntimeSource((source) => this.evaluate(source));
    this.runtimeGlobals = new Set(Object.getOwnPropertyNames(this.scope));
  }

  /** True when a promise belongs to this realm (its rejection is this realm's async error). */
  owns(promise: unknown): boolean {
    return Boolean(promise && Object.getPrototypeOf(promise) === this.promiseProto);
  }

  /** An unhandled rejection in this realm: the cell reports it, as a page's unhandledrejection. */
  noteRejection(reason: unknown): void {
    this.asynchronousError = messageOf(reason);
  }

  receive(message: Record<string, unknown>): void {
    if (this.disposed) return;
    if (message.kind === "reply") {
      const waiter = this.pending.get(String(message.callId));
      this.pending.delete(String(message.callId));
      if (typeof message.error === "string") waiter?.reject(message.error);
      else waiter?.resolve(message.value === undefined ? undefined : JSON.stringify(message.value));
    } else if (message.kind === "stop") {
      // reset drops the realm. keep stops the cell and leaves the realm, so the partial value can
      // be posted and the next cell in this chat still sees its variables.
      this.stopped = true;
      this.keep = message.keep === true;
      const reason = this.keep ? "TIMEOUT: browser cell did not finish" : "RUN_RESET";
      for (const waiter of this.pending.values()) waiter.reject(reason);
      this.pending.clear();
    } else if (message.kind === "cell") {
      // One cell at a time, and only while this realm is alive. A deadline stops the realm, so a
      // timed-out cell does not keep running and its late result cannot reach the next cell.
      if (this.stopped) return;
      this.queue = this.queue
        .then(() => (this.stopped ? undefined : this.run(message)))
        .catch(() => undefined);
    }
  }

  /** Drops the realm: its timers stop and nothing it does reaches the host again. */
  dispose(): void {
    this.receive({ kind: "stop" });
    this.disposed = true;
    clearRealmTimers(this.timers);
  }

  private evaluate(source: string, filename = "graft-runtime.js", timeout?: number): unknown {
    return vm.runInContext(source, this.context, {
      filename,
      ...(timeout ? { timeout } : {}),
    });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.disposed) this.post(message);
  }

  private print = (...values: unknown[]): void => {
    this.output += values.map(formatValue).join(" ") + "\n";
    if (this.output.length > 1_000_000)
      this.output =
        this.output.slice(0, 999_900) +
        "\n[Console limit reached; save large data with artifact() instead.]\n";
  };

  private install(): void {
    const print = this.print;
    // Host callables are reached only through wrappers made inside the realm, so a script never
    // holds a host function (or a host error) it could walk to the host's constructors from.
    const bridge = this.evaluate(`(function (host) {
      var call = (name) => function () {
        try { return host(name, Array.prototype.slice.call(arguments)); }
        catch (error) { throw new Error(String(error && error.message || error)); }
      };
      var log = call('print');
      globalThis.console = Object.freeze({ log, info: log, warn: log, error: log, debug: log });
      globalThis.__encodeBytes = call('encodeBytes');
      globalThis.__repl = call('repl');
      var post = call('call');
      globalThis.__call = function (request) {
        return new Promise(function (resolve, reject) {
          var answer = function (text) { resolve(text === undefined ? undefined : JSON.parse(text)); };
          var fail = function (message) { reject(new Error(message)); };
          try { post(request, answer, fail); } catch (error) { reject(error); }
        });
      };
    })`) as (host: (name: string, args: unknown[]) => unknown) => void;
    bridge((name, args) => {
      if (name === "print") return print(...args);
      if (name === "encodeBytes") return encodeBytes(args[0]);
      if (name === "repl") return toReplScript(String(args[0]));
      return this.call(args[0], args[1] as Waiter["resolve"], args[2] as Waiter["reject"]);
    });
  }

  private call(request: unknown, resolve: Waiter["resolve"], reject: Waiter["reject"]): void {
    if (this.stopped) {
      reject(this.keep ? "TIMEOUT: browser cell did not finish" : "RUN_RESET");
      return;
    }
    const callId = String(++this.sequence);
    this.pending.set(callId, { resolve, reject });
    this.send({ kind: "call", cellId: this.cellId, callId, request: portable(request) });
  }

  private async run(message: Record<string, unknown>): Promise<void> {
    this.cellId = String(message.cellId);
    this.send({ kind: "started", cellId: this.cellId });
    this.output = "";
    this.asynchronousError = undefined;
    let value: unknown;
    let error: string | undefined;
    const code = String(message.code);
    try {
      value = await this.evaluateCell(message, code);
    } catch (caught) {
      error = withHint(this.scope, nameModelCodeError(asError(caught)), messageOf(caught), code);
    }
    // A deadline keeps the realm and returns what the cell had built. A reset posts nothing.
    if (this.stopped) {
      if (this.keep) this.postPartial();
      return;
    }
    await this.finishCell();
    // A rejection nothing handled is reported after the microtasks drain, as a page reports it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    error ??= this.asynchronousError;
    if (!error) this.tip(code);
    const screenshots = this.screenshots();
    this.send({
      kind: "done",
      cellId: this.cellId,
      value: portable(value),
      output: this.output,
      ...(screenshots.length ? { screenshots } : {}),
      ...(error ? { error } : {}),
    });
  }

  private async evaluateCell(message: Record<string, unknown>, code: string): Promise<unknown> {
    this.evaluate("__beginCell()");
    if (message.attached) {
      this.evaluate(`globalThis.__attachedTarget = ${JSON.stringify(portable(message.attached))};`);
      if (!this.evaluate("__lastTarget")) this.evaluate("bu.use(__attachedTarget)");
    }
    // Named, so a timer the cell's own code sets can be told from the runtime's (code-api-sleep).
    const syncMs = Number(message.timeoutMs) > 0 ? Number(message.timeoutMs) : CELL_SYNC_MS;
    // Long helpers (page.list) end their own loops a few seconds before the cell's deadline.
    this.evaluate(`globalThis.__cellEndsAt = ${Date.now() + syncMs};`);
    let value = await this.evaluate(toReplScript(code), "graft-cell.js", syncMs);
    const delivered = this.evaluate("__hasDelivered ? {value: __deliveryValue} : null") as {
      value: unknown;
    } | null;
    // finish_from_js: the value is the run's answer, handed to the user as it is.
    if (delivered) value = { delivered: true, answer: delivered.value };
    return value;
  }

  private async finishCell(): Promise<void> {
    // Calls the cell started but did not await still finish before the final observation.
    for (let waited = 0; this.pending.size && !this.stopped && waited < 10_000; waited += 5)
      await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      const slept = String(this.evaluate("__sleepReport()") || "");
      if (slept) this.print(slept);
    } catch {
      // The report is a hint; a cell never fails on it.
    }
    // The final observation is not the cell's work: it must never burn the whole deadline when a
    // tab is hung or held by another chat. Give it a short, fixed budget and still answer.
    try {
      await bounded(this.evaluate("__finishCell()"), 5000);
    } catch (caught) {
      this.print("Final observation unavailable:", messageOf(caught));
    }
  }

  private screenshots(): string[] {
    try {
      const shots = portable(this.evaluate("__shotPaths"));
      if (Array.isArray(shots))
        return shots.filter((shot): shot is string => typeof shot === "string").slice(0, 32);
    } catch {
      // A cell with no screenshot helper still finishes.
    }
    return [];
  }

  /** The value a timed-out cell had built: the pool's partial, else the largest array it left. */
  private readPartial(): unknown {
    try {
      const marked = this.evaluate("globalThis.__partialValue");
      if (marked !== undefined) return marked;
    } catch {
      // No partial was published.
    }
    try {
      let best: unknown;
      let count = -1;
      for (const key of Object.getOwnPropertyNames(this.scope)) {
        if (key.startsWith("__") || this.runtimeGlobals.has(key)) continue;
        const value = this.scope[key];
        if (Array.isArray(value) && value.length > count) {
          best = value;
          count = value.length;
        }
      }
      return best;
    } catch {
      return undefined;
    }
  }

  private postPartial(): void {
    this.send({
      kind: "done",
      cellId: this.cellId,
      value: portable(this.readPartial()),
      output: this.output,
      error: "TIMEOUT: browser cell did not finish; partial value returned",
    });
    this.stopped = false;
    this.keep = false;
  }

  /** Adds a one-line "Tip:" to the output when the cell took the long way to something. */
  private tip(code: string): void {
    try {
      const text = String((this.scope.__tip as (code: string) => string)(code) || "");
      if (text) this.print("Tip: " + text);
    } catch {
      // No tip.
    }
  }
}

/** A promise that outlives `ms` fails; the cell still posts its result. */
function bounded<T>(work: T | Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("TIMEOUT: final observation did not answer")),
      ms,
    );
    Promise.resolve(work).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(messageOf(error)));
      },
    );
  });
}

/** A realm's error as a host Error, so shared naming code reads its message. */
function asError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(messageOf(caught));
}

/** The error with a "did you mean" from the realm's real API, when one applies. */
/** `raw` is the error as thrown, which the API's own "did you mean" reads; `message` is named. */
function withHint(
  scope: Record<string, unknown>,
  message: string,
  raw: string,
  code: string,
): string {
  let hint = "";
  try {
    hint = String((scope.__hint as (text: string, code: string) => string)(raw, code) || "");
  } catch {
    // No hint: the error stands as it is.
  }
  // A drifted ability names its repair. Otherwise the shared code says how to recover.
  const repair = abilityRepairCall(message);
  if (repair) hint = ABILITY_REPAIR_HINT;
  else hint ||= message.includes("\nHint: ") ? "" : errorHint(leadingCode(message) ?? "");
  const next = /\nNext: /.test(message) ? "" : repair || errorNextCall(leadingCode(message) ?? "");
  const lines = [message, ...(hint ? [`Hint: ${hint}`] : []), ...(next ? [`Next: ${next}`] : [])];
  return lines.join("\n");
}
