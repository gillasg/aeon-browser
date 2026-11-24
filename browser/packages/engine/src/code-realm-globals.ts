// The globals a browser_code realm gets in the local Aeon process: the Web and JS platform a cell
// relied on in the browser (timers, URL, encoding, crypto, fetch types), and nothing of Node.
// No process, require, module, Buffer or file and child-process access is ever placed in a realm.
import vm from "node:vm";
import { webcrypto } from "node:crypto";

/** Timers one realm set, so dropping the realm stops every one of them. */
export interface RealmTimers {
  timeouts: Set<number>;
  intervals: Set<number>;
}

const PLATFORM = [
  "URL",
  "URLSearchParams",
  "atob",
  "btoa",
  "TextEncoder",
  "TextDecoder",
  "structuredClone",
  "Headers",
  "Request",
  "Response",
  "Blob",
  "FormData",
  "AbortController",
  "AbortSignal",
  "Event",
  "EventTarget",
  "DOMException",
] as const;

// Every value a realm can reach from the host goes through this, so a script cannot walk from a
// host function to the host's Function constructor. Run once in the process that hosts realms.
let hardened = false;
export function hardenHost(): void {
  if (hardened) return;
  hardened = true;
  const blocked = function constructorBlocked(): never {
    throw new Error("UNSUPPORTED: code generation through a host constructor");
  };
  const prototypes = [
    Function.prototype,
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ] as object[];
  for (const prototype of prototypes)
    Object.defineProperty(prototype, "constructor", {
      value: blocked,
      writable: false,
      configurable: false,
    });
}

function timers(sandbox: Record<string, unknown>, owned: RealmTimers): void {
  const forget = (set: Set<number>, id: number) => set.delete(id);
  sandbox.setTimeout = (fn: unknown, ms?: unknown, ...args: unknown[]) => {
    if (typeof fn !== "function") return 0;
    let id = 0;
    const timer = setTimeout(
      () => {
        forget(owned.timeouts, id);
        (fn as (...items: unknown[]) => void)(...args);
      },
      Number(ms) || 0,
    );
    id = Number(timer);
    owned.timeouts.add(id);
    return id;
  };
  sandbox.clearTimeout = (id: unknown) => {
    if (typeof id !== "number") return;
    owned.timeouts.delete(id);
    clearTimeout(id);
  };
  sandbox.setInterval = (fn: unknown, ms?: unknown, ...args: unknown[]) => {
    if (typeof fn !== "function") return 0;
    const timer = setInterval(
      () => (fn as (...items: unknown[]) => void)(...args),
      Number(ms) || 0,
    );
    const id = Number(timer);
    owned.intervals.add(id);
    return id;
  };
  sandbox.clearInterval = (id: unknown) => {
    if (typeof id !== "number") return;
    owned.intervals.delete(id);
    clearInterval(id);
  };
  sandbox.queueMicrotask = (fn: unknown) => {
    if (typeof fn === "function") queueMicrotask(fn as () => void);
  };
}

/** Stops every timer the realm still holds. */
export function clearRealmTimers(owned: RealmTimers): void {
  for (const id of owned.timeouts) clearTimeout(id);
  for (const id of owned.intervals) clearInterval(id);
  owned.timeouts.clear();
  owned.intervals.clear();
}

/** A fresh context with only the platform globals a cell may use. */
export function createRealmContext(owned: RealmTimers): vm.Context {
  const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const host = globalThis as unknown as Record<string, unknown>;
  for (const name of PLATFORM) if (host[name] !== undefined) sandbox[name] = host[name];
  sandbox.crypto = webcrypto;
  sandbox.performance = { now: () => performance.now(), timeOrigin: performance.timeOrigin };
  timers(sandbox, owned);
  const context = vm.createContext(sandbox, {
    name: "aeon-browser-code",
    codeGeneration: { strings: true, wasm: false },
  });
  // The realm's own name for its global, as a page realm has; set from inside the realm so it
  // is the context's global, not the host object the context was made from.
  vm.runInContext("globalThis.window = globalThis; globalThis.self = globalThis;", context);
  return context;
}
