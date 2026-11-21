// One chat's browser_code realm. Runs in a manifest sandbox page, where eval is allowed and
// no extension APIs exist; every browser or workspace request goes to the parent document.
import { toReplScript } from "./code-repl.js";
import {
  abilityRepairCall,
  ABILITY_REPAIR_HINT,
  errorHint,
  errorNextCall,
  leadingCode,
  nameModelCodeError,
} from "@browserkit/protocol";
import { browserCodeApi } from "./code-api.js";
import { browserFastApi } from "./code-api-page.js";
import { browserCapabilityApi, browserDocumentApi } from "./code-api-hooks.js";
import { browserPlaywrightApi } from "./code-api-playwright.js";
import { browserDataApi } from "./code-api-data.js";
import { browserListApi } from "./code-api-list.js";
import { browserScrollersApi } from "./code-api-scrollers.js";
import { browserEventsApi } from "./code-api-events.js";
import { browserDemonstrationApi } from "./code-api-demonstration.js";
import { browserRecordingApi } from "./code-api-recording.js";
import { browserSitesApi } from "./code-api-sites.js";
import { browserContextApi } from "./code-api-context.js";
import { browserSnipeApi } from "./code-api-snipe.js";
import { browserTablesApi } from "./code-api-tables.js";
import { browserHelpApi } from "./code-api-help.js";
import { browserControlsApi } from "./code-api-controls.js";
import { browserMediaChallengesApi } from "./code-api-media-challenges.js";
import { browserMediaApi } from "./code-media-api.js";
import { browserSurfaceApi, browserWindowApi } from "./code-api-surface.js";
import { browserActApi } from "./code-api-act.js";
import { browserSleepApi } from "./code-api-sleep.js";
import { browserSpeedApi } from "./code-api-speed.js";
import { browserMcpApi } from "./code-api-mcp.js";

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const scope = globalThis as unknown as Record<string, unknown>;
const evaluate = (source: string): unknown => (0, eval)(source);
const pending = new Map<string, Waiter>();
let cellId = "";
let sequence = 0;
let queue: Promise<void> = Promise.resolve();
let output = "";
let asynchronousError: string | undefined;
let stopped = false;
let keep = false;

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
        reject(error);
      },
    );
  });
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  // page.url and page.title are callable strings; print them as the string they stand for.
  if (typeof value === "function" && Symbol.toPrimitive in value) return String(value);
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  try {
    return (
      JSON.stringify(
        value,
        (_key, item: unknown) => (typeof item === "bigint" ? String(item) : item),
        2,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
}
/** Binary artifact data as bytes: typed arrays, ArrayBuffers, Blobs read first, or byte arrays. */
function asBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  throw new Error(
    "artifact() takes a string, Uint8Array, ArrayBuffer or byte array; for a Blob, pass new Uint8Array(await blob.arrayBuffer())",
  );
}
const print = (...values: unknown[]) => {
  output += values.map(format).join(" ") + "\n";
  if (output.length > 1_000_000)
    output =
      output.slice(0, 999_900) +
      "\n[Console limit reached; save large data with artifact() instead.]\n";
};
scope.console = Object.freeze({ log: print, info: print, warn: print, error: print, debug: print });
scope.__encodeBytes = (data: unknown) => {
  const bytes = asBytes(data);
  if (bytes.byteLength > 16_000_000) throw new Error("Binary artifact exceeds 16 MB; split it");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};
// Skills are evaluated with the same REPL rules as cells, so `const helper = ...` persists.
scope.__repl = toReplScript;
scope.__call = (request: unknown) => {
  if (stopped)
    return Promise.reject(new Error(keep ? "TIMEOUT: browser cell did not finish" : "RUN_RESET"));
  return new Promise((resolve, reject) => {
    const callId = String(++sequence);
    pending.set(callId, { resolve, reject });
    parent.postMessage({ kind: "call", cellId, callId, request }, "*");
  });
};
evaluate(
  [
    browserWindowApi,
    browserSurfaceApi,
    browserMediaApi,
    browserCodeApi,
    browserSitesApi,
    browserContextApi,
    browserSnipeApi,
    browserTablesApi,
    browserHelpApi,
    browserFastApi,
    browserCapabilityApi,
    browserDocumentApi,
    browserPlaywrightApi,
    browserDataApi,
    browserListApi,
    browserScrollersApi,
    browserEventsApi,
    browserRecordingApi,
    browserDemonstrationApi,
    browserControlsApi,
    browserMediaChallengesApi,
    browserActApi,
    browserSleepApi,
    browserSpeedApi,
    browserMcpApi,
  ].join("\n"),
);

window.addEventListener("unhandledrejection", (event) => {
  asynchronousError = event.reason instanceof Error ? event.reason.message : String(event.reason);
  event.preventDefault();
});

window.addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const message = event.data as Record<string, unknown>;
  if (message.kind === "reply") {
    const waiter = pending.get(String(message.callId));
    pending.delete(String(message.callId));
    if (typeof message.error === "string") waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.value);
  } else if (message.kind === "stop") {
    // reset drops the frame. keep stops the cell and leaves the realm, so the partial value can
    // be posted and the next cell in this chat still sees its variables.
    stopped = true;
    keep = message.keep === true;
    const reason = keep ? "TIMEOUT: browser cell did not finish" : "RUN_RESET";
    for (const waiter of pending.values()) waiter.reject(new Error(reason));
    pending.clear();
  } else if (message.kind === "cell") {
    // One cell at a time, and only while this frame is alive. A deadline stops the frame, so a
    // timed-out cell does not keep running and its late result cannot reach the next cell.
    if (stopped) return;
    queue = queue.then(() => (stopped ? undefined : run(message))).catch(() => undefined);
  }
});

async function run(message: Record<string, unknown>): Promise<void> {
  cellId = String(message.cellId);
  parent.postMessage({ kind: "started", cellId }, "*");
  output = "";
  asynchronousError = undefined;
  let value: unknown;
  let error: string | undefined;
  try {
    evaluate("__beginCell()");
    if (message.attached) scope.__attachedTarget = message.attached;
    if (message.attached && !evaluate("__lastTarget"))
      (scope.bu as { use(target: unknown): unknown }).use(message.attached);
    // Named, so a timer the cell's own code sets can be told from the runtime's (code-api-sleep).
    value = await evaluate(toReplScript(String(message.code)) + "\n//# sourceURL=aeon-cell.js");
    const delivered = evaluate("__hasDelivered ? {value: __deliveryValue} : null") as {
      value: unknown;
    } | null;
    // finish_from_js: the value is the run's answer, handed to the user as it is.
    if (delivered) value = { delivered: true, answer: delivered.value };
  } catch (caught) {
    error = withHint(
      nameModelCodeError(caught),
      caught instanceof Error ? caught.message : String(caught),
      String(message.code),
    );
  }
  // A deadline keeps the realm and returns what the cell had built. A reset posts nothing.
  if (stopped) {
    if (keep) postPartial();
    return;
  }
  // Calls the cell started but did not await still finish before the final observation.
  for (let waited = 0; pending.size && !stopped && waited < 10_000; waited += 5)
    await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const slept = String(evaluate("__sleepReport()") || "");
    if (slept) print(slept);
  } catch {
    // The report is a hint; a cell never fails on it.
  }
  // The final observation is not the cell's work: it must never burn the whole deadline when a
  // tab is hung or held by another chat. Give it a short, fixed budget and still answer.
  try {
    await bounded(evaluate("__finishCell()"), 5000);
  } catch (caught) {
    print("Final observation unavailable:", String(caught));
  }
  error ??= asynchronousError;
  if (!error) tip(String(message.code));
  parent.postMessage(
    { kind: "done", cellId, value: portable(value), output, ...(error ? { error } : {}) },
    "*",
  );
}

/** The value a timed-out cell had built: the pool's partial, else the largest array it left. */
function readPartial(): unknown {
  try {
    const marked = evaluate("globalThis.__partialValue");
    if (marked !== undefined) return marked;
  } catch {
    // No partial was published.
  }
  try {
    return evaluate(`(() => {
      let best, count = -1;
      for (const key of Object.getOwnPropertyNames(globalThis)) {
        if (key.startsWith("__")) continue;
        const value = globalThis[key];
        if (Array.isArray(value) && value.length > count) { best = value; count = value.length; }
      }
      return best;
    })()`);
  } catch {
    return undefined;
  }
}

function postPartial(): void {
  parent.postMessage(
    {
      kind: "done",
      cellId,
      value: portable(readPartial()),
      output,
      error: "TIMEOUT: browser cell did not finish; partial value returned",
    },
    "*",
  );
  stopped = false;
  keep = false;
}

/** Adds a one-line "Tip:" to the output when the cell took the long way to something. */
function tip(code: string): void {
  try {
    const text = String((scope.__tip as (code: string) => string)(code) || "");
    if (text) print("Tip: " + text);
  } catch {
    // No tip.
  }
}

/** The error with a "did you mean" from the realm's real API, when one applies. */
/** `raw` is the error as thrown, which the API's own "did you mean" reads; `message` is named. */
function withHint(message: string, raw: string, code: string): string {
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

function portable(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}
