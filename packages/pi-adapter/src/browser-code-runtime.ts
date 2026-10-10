import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";

type BrowserCall = (step: unknown) => Promise<unknown>;
export interface BrowserCellResult {
  value?: unknown;
  output: string;
  reset?: boolean;
}
interface Cell {
  id: string;
  call: BrowserCall;
  resolve: (value: BrowserCellResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
const runtimes = new Map<string, BrowserCodeRuntime>();
export function browserRuntime(chatId: string): BrowserCodeRuntime {
  let runtime = runtimes.get(chatId);
  if (!runtime) {
    runtime = new BrowserCodeRuntime();
    runtimes.set(chatId, runtime);
  }
  return runtime;
}
export function disposeBrowserRuntime(chatId: string): void {
  runtimes.get(chatId)?.close();
  runtimes.delete(chatId);
}
export class BrowserCodeRuntime {
  private worker: ChildProcess | undefined;
  private cell: Cell | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private closed = false;
  constructor(private readonly timeoutMs = 30_000) {}
  execute(code: string, call: BrowserCall, signal?: AbortSignal): Promise<BrowserCellResult> {
    const work = this.chain.catch(() => undefined).then(() => this.evaluate(code, call, signal));
    this.chain = work;
    return work;
  }
  close(): void {
    this.closed = true;
    this.stop(new Error("Browser runtime closed"));
  }
  private start(): ChildProcess {
    const options: ForkOptions & { windowsHide: boolean } = {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
      execArgv: ["--max-old-space-size=64"],
      serialization: "advanced",
    };
    const worker = fork(new URL("./browser-code-worker.js", import.meta.url), [], options);
    this.worker = worker;
    this.generation++;
    worker.on("message", (message: unknown) => this.receive(worker, message));
    worker.on("error", (error) => {
      if (this.worker === worker) this.stop(error);
    });
    worker.on("exit", () => {
      if (this.worker === worker) this.stop(new Error("Browser worker exited; runtime reset"));
    });
    return worker;
  }
  private evaluate(code: string, call: BrowserCall, signal?: AbortSignal) {
    if (this.closed) throw new Error("Browser runtime closed");
    if (signal?.aborted) throw new Error("Browser workflow cancelled");
    const fresh = !this.worker;
    const worker = this.worker ?? this.start();
    worker.ref();
    worker.channel?.ref();
    return new Promise<BrowserCellResult>((resolve, reject) => {
      const abort = () => this.stop(new Error("Browser workflow cancelled; runtime reset"));
      const timer = setTimeout(
        () => this.stop(new Error("Browser code exceeded its deadline; runtime reset")),
        this.timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        worker.unref();
        worker.channel?.unref();
      };
      const id = randomUUID();
      this.cell = { id, call, resolve, reject, cleanup };
      worker.send({ kind: "cell", id, code, reset: fresh && this.generation > 1 }, (error) => {
        if (error && this.cell?.id === id) this.stop(error);
      });
    });
  }
  private receive(worker: ChildProcess, raw: unknown): void {
    const message = raw as {
      kind?: string;
      id?: string;
      requestId?: string;
      step?: unknown;
      error?: string;
      value?: unknown;
      output?: string;
      reset?: boolean;
    };
    const cell = this.cell;
    if (worker !== this.worker || !cell || message.id !== cell.id) return;
    if (message.kind === "call") {
      const reply = (result: { value?: unknown; error?: string }) => {
        if (worker.connected && this.cell === cell)
          worker.send(
            { kind: "reply", id: cell.id, requestId: message.requestId, ...result },
            () => {},
          );
      };
      void cell.call(message.step).then(
        (value) => reply({ value }),
        (error: unknown) =>
          reply({ error: error instanceof Error ? error.message : String(error) }),
      );
      return;
    }
    if (message.kind !== "result") return;
    if (message.error?.includes("Cannot find context with specified id")) {
      this.stop(
        new Error(
          "Browser execution context was lost; runtime reset. Rebuild bindings before the next call; completed browser actions were not replayed.",
        ),
      );
      return;
    }
    this.cell = undefined;
    cell.cleanup();
    if (message.error)
      cell.reject(new Error(message.error + (message.output ? "\n" + message.output : "")));
    else
      cell.resolve({
        value: message.value,
        output: message.output ?? "",
        ...(message.reset ? { reset: true } : {}),
      });
  }
  private stop(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    const cell = this.cell;
    this.cell = undefined;
    cell?.cleanup();
    cell?.reject(error);
    worker?.kill();
  }
}
