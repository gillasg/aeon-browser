import { readFile } from "node:fs/promises";
import { QuickJS, type JSValueHandle } from "quickjs-wasi";
import { browserCodeApi } from "./browser-code-api.js";
let modulePromise: Promise<WebAssembly.Module> | undefined;

function wasmModule(): Promise<WebAssembly.Module> {
  return (modulePromise ??= readFile(
    new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm")),
  ).then((bytes) => WebAssembly.compile(bytes)));
}

export async function executeBrowserCode(
  code: string,
  call: (step: unknown) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const deadline = Date.now() + 30_000;
  const vm = await QuickJS.create({
    wasm: await wasmModule(),
    memoryLimit: 16 * 1024 * 1024,
    interruptHandler: () => !!signal?.aborted || Date.now() >= deadline,
  });
  let closed = false;
  const stop = codeDeadline(signal, deadline);
  const pending = new Set<Promise<void>>();
  const hostCall = vm.newFunction("__call", (argument: JSValueHandle) => {
    const step = vm.dump(argument);
    const deferred = vm.newPromise();
    const work = call(step)
      .then(
        (value) => settle(value, false),
        (error: unknown) => settle(error instanceof Error ? error.message : String(error), true),
      )
      .catch(stop.fail);
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => undefined);
    function settle(value: unknown, failed: boolean): void {
      if (closed) return;
      using handle = failed ? vm.newError(String(value)) : vm.hostToHandle(value);
      if (failed) deferred.reject(handle);
      else deferred.resolve(handle);
      vm.executePendingJobs();
    }
    return deferred.handle;
  });
  try {
    vm.setProp(vm.global, "__call", hostCall);
    using promise = vm.evalCode(`${browserCodeApi}\n(async () => {${code}\n})()`);
    vm.executePendingJobs();
    const result = await Promise.race([vm.resolvePromise(promise), stop.promise]);
    if ("error" in result) throw new Error(result.error.consume((handle) => handle.toString()));
    while (pending.size) await Promise.race([Promise.allSettled([...pending]), stop.promise]);
    return result.value.consume((handle) => vm.dump(handle));
  } finally {
    closed = true;
    stop.close();
    hostCall.dispose();
    vm.dispose();
  }
}

function codeDeadline(signal: AbortSignal | undefined, deadline: number) {
  let timer: NodeJS.Timeout | undefined;
  let abort = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<never>((_, reject) => {
    fail = reject;
    abort = () => reject(new Error("Browser workflow cancelled"));
    timer = setTimeout(
      () => reject(new Error("Browser code exceeded 30 seconds")),
      Math.max(0, deadline - Date.now()),
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  return {
    promise,
    fail,
    close: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}
