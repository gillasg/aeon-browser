import { Session, type Runtime } from "node:inspector";
import { createContext, runInContext } from "node:vm";
import { inspect } from "node:util";
import { browserCodeApi } from "./browser-code-api.js";
import { browserFastApi } from "./browser-fast-api.js";
import { browserCapabilityApi } from "./browser-capability-api.js";
import { browserDocumentApi } from "./browser-document-api.js";
const inspector = new Session();
inspector.connect();
let contextId: number | undefined;
inspector.on("Runtime.executionContextCreated", ({ params }) => {
  if (params.context.name === "browser-code") contextId = params.context.id;
});
inspector.post("Runtime.enable");
let cellId = "",
  output = "",
  sequence = 0;
let asynchronousError: string | undefined;
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const print = (...values: unknown[]) => {
  output =
    output +
    values
      .map((value) =>
        typeof value === "string"
          ? value
          : inspect(value, { depth: 6, maxStringLength: 1_000_000, maxArrayLength: null }),
      )
      .join(" ") +
    "\n";
  if (output.length > 1_000_000)
    output =
      output.slice(0, 999900) +
      "\n[Console limit reached; save large data with artifact() instead.]\n";
};
const realm = createContext(
  {
    console: Object.freeze({ log: print, info: print, warn: print, error: print }),
    __encodeBytes: (bytes: Uint8Array) => {
      if (bytes.byteLength > 16_000_000) throw new Error("Binary artifact exceeds 16 MB; split it");
      return Buffer.from(bytes).toString("base64");
    },
    __call: (step: unknown) =>
      new Promise((resolve, reject) => {
        const requestId = String(++sequence);
        pending.set(requestId, { resolve, reject });
        process.send?.({ kind: "call", id: cellId, requestId, step });
      }),
  },
  { name: "browser-code" },
);
function evaluate(expression: string): Promise<Runtime.EvaluateReturnType> {
  // Inspector context ids are weak references. Keep the VM realm reachable between turns.
  runInContext("void 0", realm);
  return new Promise((resolve, reject) =>
    inspector.post(
      "Runtime.evaluate",
      {
        expression,
        contextId,
        awaitPromise: true,
        returnByValue: true,
        replMode: true,
      },
      (error, result) => (error ? reject(error) : resolve(result as Runtime.EvaluateReturnType)),
    ),
  );
}
const ready = evaluate(
  browserCodeApi + "\n" + browserFastApi + "\n" + browserCapabilityApi + "\n" + browserDocumentApi,
);
// Inspector awaits cross-context promises. Surface detached rejections as cell errors instead of crashing the worker.
process.on("unhandledRejection", (error: unknown) => {
  asynchronousError = error instanceof Error ? error.message : String(error);
});
process.on("disconnect", () => process.exit(0));
process.on("message", (raw: unknown) => {
  const message = raw as {
    kind: string;
    id: string;
    code: string;
    requestId: string;
    value?: unknown;
    error?: string;
    reset?: boolean;
  };
  if (message.kind === "reply") {
    if (message.id !== cellId) return;
    const waiter = pending.get(message.requestId);
    pending.delete(message.requestId);
    if (message.error) waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.value);
  } else if (message.kind === "cell") void run(message);
});
async function run(message: { id: string; code: string; reset?: boolean }) {
  cellId = message.id;
  output = "";
  asynchronousError = undefined;
  let value: unknown, error: string | undefined;
  try {
    assertResult(await ready);
    await evaluate("__beginCell()");
    const result = await executeCell(message.code);
    value = result.result.value;
    const delivered = await evaluate("__hasDelivered ? {value:__deliveryValue} : null");
    if (delivered.result.value) value = delivered.result.value.value;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  while (pending.size) await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    assertResult(await evaluate("await __finishCell()"));
  } catch (caught) {
    print("Final observation unavailable:", String(caught));
  }
  error ??= asynchronousError;
  process.send?.({
    kind: "result",
    id: cellId,
    value,
    output,
    ...(error ? { error } : {}),
    ...(message.reset ? { reset: true } : {}),
  });
}
function assertResult(result: Runtime.EvaluateReturnType): void {
  const details = result.exceptionDetails;
  if (details) throw new Error(details.exception?.description ?? details.text);
}
async function executeCell(code: string) {
  let result = await evaluate(code);
  // Syntax rejection happens before execution, so legacy return workflows can be wrapped safely.
  if (result.exceptionDetails?.exception?.description?.includes("Illegal return statement"))
    result = await evaluate(`await (async () => {${code}\n})()`);
  assertResult(result);
  return result;
}
