// The worker thread one pack script (site tool or node ability) runs in. The script gets a fresh
// context with no Node globals; its only reach out is a string-only message bridge to the parent.
// Every host constructor is sealed first, so walking from a bridge function or a host promise to
// the host's Function constructor finds a function that throws, never `process`.
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

interface Job {
  code: string;
  inputs: string;
  filename: string;
  bridges: string[];
  timeoutMs: number;
}

function sealHost(): void {
  const proc = process as unknown as Record<string, unknown>;
  for (const name of ["getBuiltinModule", "binding", "_linkedBinding", "dlopen"])
    try {
      Object.defineProperty(proc, name, { value: undefined, writable: false, configurable: false });
    } catch {
      // A property the runtime keeps stays; the constructor seal below still holds.
    }
  const blocked = function constructorBlocked(): never {
    throw new Error("SANDBOX: code generation through a host constructor is not allowed");
  };
  for (const prototype of [
    Function.prototype,
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ] as object[])
    Object.defineProperty(prototype, "constructor", {
      value: blocked,
      writable: false,
      configurable: false,
    });
}

const port = parentPort;
if (!port) throw new Error("script-sandbox-worker runs as a worker thread");
const job = workerData as Job;
const waiting = new Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }>();
let sequence = 0;
sealHost();

port.on("message", (message: { id: number; ok: boolean; text: string }) => {
  const waiter = waiting.get(message.id);
  if (!waiter) return;
  waiting.delete(message.id);
  if (message.ok) waiter.resolve(message.text);
  else waiter.reject(new Error(message.text));
});

const bridge = (kind: unknown, payload: unknown): Promise<string> =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    waiting.set(id, { resolve, reject });
    port.postMessage({ type: "rpc", id, kind: String(kind), payload: String(payload) });
  });

// Built inside the realm, so every object and function the script sees is the realm's own.
const PRELUDE = `(() => {
  const bridge = globalThis.__bridge;
  delete globalThis.__bridge;
  const names = JSON.parse(globalThis.__names);
  delete globalThis.__names;
  const send = (kind) => async (...items) => {
    let text;
    try { text = await bridge(kind, JSON.stringify(items)); }
    catch (error) { throw new Error(String(error && error.message)); }
    return text === undefined || text === "" ? undefined : JSON.parse(text);
  };
  const siteMapper = {};
  for (const name of names.filter((n) => n !== "fetch")) siteMapper[name] = send(name);
  globalThis.siteMapper = Object.freeze(siteMapper);
  globalThis.browser = Object.freeze({ fetch: send("fetch") });
  globalThis.args = globalThis.inputs = JSON.parse(globalThis.__inputs);
  delete globalThis.__inputs;
})();`;

async function run(): Promise<string> {
  const sandbox = Object.create(null) as Record<string, unknown>;
  sandbox.__bridge = bridge;
  sandbox.__names = JSON.stringify(job.bridges);
  sandbox.__inputs = job.inputs;
  for (const name of ["URL", "URLSearchParams", "TextEncoder", "TextDecoder", "atob", "btoa"])
    sandbox[name] = (globalThis as Record<string, unknown>)[name];
  const context = vm.createContext(sandbox, {
    name: "graft-pack-script",
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(PRELUDE, context);
  const script = new vm.Script(
    `(async () => { const value = await (async () => { ${job.code}\n })();` +
      ` return value === undefined ? "" : JSON.stringify(value); })()`,
    { filename: job.filename },
  );
  return (await script.runInContext(context, { timeout: job.timeoutMs })) as string;
}

run().then(
  (text) => port.postMessage({ type: "done", ok: true, text: String(text) }),
  (error: unknown) =>
    port.postMessage({
      type: "done",
      ok: false,
      text: String((error as { message?: unknown } | null)?.message ?? error),
    }),
);
