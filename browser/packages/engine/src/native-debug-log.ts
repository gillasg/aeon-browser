// A small rolling record of engine decisions (hand-offs, vault saves, debugger probes) kept in
// the service worker's memory. Real-browser tests and support sessions read it through the
// worker's own DevTools target, so a flow that stalls can say exactly where it stopped.
export type EngineDebugEntry = {
  at: number;
  scope: string;
  message: string;
  data?: unknown;
};

const LIMIT = 400;
const entries: EngineDebugEntry[] = [];

export function engineDebug(scope: string, message: string, data?: unknown): void {
  entries.push({ at: Date.now(), scope, message, ...(data === undefined ? {} : { data }) });
  if (entries.length > LIMIT) entries.shift();
}

export function readEngineDebug(): EngineDebugEntry[] {
  return entries.slice();
}

// The bundled worker has no module exports at runtime; the buffer is read through this hook.
const hook = globalThis as typeof globalThis & {
  __aeonEngineDebug?: () => EngineDebugEntry[];
};
hook.__aeonEngineDebug ??= readEngineDebug;
