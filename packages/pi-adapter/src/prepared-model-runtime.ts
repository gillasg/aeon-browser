import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join } from "node:path";

/** One unbound runtime, never shared by two live sessions or extension registries. */
export class PreparedModelRuntime {
  private pending: Promise<ModelRuntime> | undefined;
  private signature = "";
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly agentDirectory: string,
    private readonly create = ModelRuntime.create,
  ) {
    this.timer = setInterval(() => this.prepare(), 30_000);
    this.timer.unref();
  }
  prepare(): void {
    if (this.closed) return;
    const signature = this.configurationSignature();
    if (this.pending && signature === this.signature) return;
    this.signature = signature;
    const pending = this.create({
      authPath: join(this.agentDirectory, "auth.json"),
      modelsPath: join(this.agentDirectory, "models.json"),
    });
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
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.pending = undefined;
  }
  private configurationSignature(): string {
    return ["auth.json", "models.json"]
      .map((file) => {
        try {
          const info = statSync(join(this.agentDirectory, file));
          return `${info.mtimeMs}:${info.size}`;
        } catch {
          return "missing";
        }
      })
      .join("|");
  }
}
