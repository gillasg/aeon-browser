import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join } from "node:path";
import { aeonModelsStorePath, createAeonModelRuntime } from "./live-models.js";

/** One unbound runtime, never shared by two live sessions or extension registries. */
export class PreparedModelRuntime {
  private pending: Promise<ModelRuntime> | undefined;
  private signature = "";
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly agentDirectory: string,
    private readonly create = createAeonModelRuntime,
  ) {
    this.timer = setInterval(() => this.prepare(), 30_000);
    this.timer.unref();
  }
  prepare(): void {
    if (this.closed) return;
    const signature = this.configurationSignature();
    if (this.pending && signature === this.signature) return;
    this.signature = signature;
    const pending = this.create({ agentDirectory: this.agentDirectory });
    this.pending = pending;
    void pending.catch(() => {
      if (this.pending === pending) this.pending = undefined;
    });
  }
  async take(): Promise<ModelRuntime> {
    this.prepare();
    const pending = this.pending;
    if (!pending) throw new Error("Model preparation is closed.");
    this.pending = undefined;
    const runtime = await pending;
    this.prepare();
    return runtime;
  }
  /** Stops preparing and waits for an in-flight runtime so callers can remove its directory. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    const pending = this.pending;
    this.pending = undefined;
    await pending?.catch(() => undefined);
  }
  private configurationSignature(): string {
    return [
      join(this.agentDirectory, "auth.json"),
      join(this.agentDirectory, "models.json"),
      aeonModelsStorePath(this.agentDirectory),
    ]
      .map((file) => {
        try {
          const info = statSync(file);
          return `${info.mtimeMs}:${info.size}`;
        } catch {
          return "missing";
        }
      })
      .join("|");
  }
}
