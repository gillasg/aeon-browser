// Runs untrusted pack code (site tools, node abilities) on a worker thread with no environment,
// a memory cap and a hard deadline. The script talks to the daemon only through named bridges
// that take and return JSON text; no daemon function, object or promise ever enters its realm.
import { Worker } from "node:worker_threads";

export type Bridge = (...items: unknown[]) => Promise<unknown>;

export interface SandboxRun {
  code: string;
  inputs: Record<string, unknown>;
  filename: string;
  /** `fetch` becomes browser.fetch; every other name becomes siteMapper.<name>. */
  bridges: Record<string, Bridge>;
  timeoutMs: number;
  timeoutMessage: string;
}

const WORKER = new URL("./script-sandbox-worker.js", import.meta.url);

export function runSandboxed(input: SandboxRun): Promise<unknown> {
  const worker = new Worker(WORKER, {
    env: {},
    argv: [],
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 256 },
    workerData: {
      code: input.code,
      inputs: JSON.stringify(input.inputs ?? {}),
      filename: input.filename,
      bridges: Object.keys(input.bridges),
      timeoutMs: input.timeoutMs,
    },
  });
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(input.timeoutMessage))),
      input.timeoutMs + 1_000,
    );
    worker.on("message", (message: Record<string, unknown>) => {
      if (message.type === "rpc") return void answer(worker, input.bridges, message);
      if (message.type !== "done") return;
      const text = String(message.text ?? "");
      if (!message.ok) return finish(() => reject(new Error(text)));
      finish(() => resolve(text === "" ? null : (JSON.parse(text) as unknown)));
    });
    worker.on("error", (error) => finish(() => reject(error)));
    worker.on("exit", (code) =>
      finish(() => reject(new Error(`SANDBOX: script worker exited (${code})`))),
    );
  });
}

async function answer(
  worker: Worker,
  bridges: Record<string, Bridge>,
  message: Record<string, unknown>,
): Promise<void> {
  const id = Number(message.id);
  try {
    const bridge = bridges[String(message.kind)];
    if (!bridge) throw new Error(`SANDBOX: no bridge ${String(message.kind)}`);
    const items = JSON.parse(String(message.payload ?? "[]")) as unknown[];
    const value = await bridge(...items);
    worker.postMessage({ id, ok: true, text: value === undefined ? "" : JSON.stringify(value) });
  } catch (error) {
    worker.postMessage({
      id,
      ok: false,
      text: error instanceof Error ? error.message : String(error),
    });
  }
}
