import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiMcpServerStatus } from "@pippin/domain";
import { createPiResourceLoader, enablePiNativeDefaultTools } from "./sdk-resources.js";
import { projectMcpStatuses } from "./session-mcp-status.js";
import { startupTiming } from "./startup-timing.js";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";

async function loadResources(
  workingDirectory: string,
  agentDirectory: string,
  browserGuidance: boolean,
) {
  const startedAt = Date.now();
  const settingsManager = SettingsManager.create(workingDirectory, agentDirectory);
  let servers: readonly PiMcpServerStatus[] = [];
  const resourceLoader = createPiResourceLoader({
    workingDirectory,
    agentDirectory,
    settingsManager,
    browserGuidance,
    onMcpStatusChange: (current) => {
      servers = projectMcpStatuses(current);
    },
  });
  await resourceLoader.reload();
  enablePiNativeDefaultTools(settingsManager);
  startupTiming("resources-ready", startedAt);
  return { settingsManager, resourceLoader, getMcpServers: () => servers };
}

/** Reserve resources for one specific future workspace; never share extension instances. */
export class PreparedSessionResources {
  private reserved:
    { directory: string; signature: string; pending: ReturnType<typeof loadResources> } | undefined;
  constructor(
    private readonly agentDirectory: string,
    private readonly browserGuidance: boolean,
    private readonly load = loadResources,
  ) {}
  prepare(workingDirectory: string): Promise<void> {
    const directory = resolve(workingDirectory);
    const signature = this.signature(directory);
    if (this.reserved?.directory === directory && this.reserved.signature === signature)
      return this.reserved.pending.then(() => undefined);
    const pending = this.load(directory, this.agentDirectory, this.browserGuidance);
    this.reserved = { directory, signature, pending };
    void pending.catch(() => {
      if (this.reserved?.pending === pending) this.reserved = undefined;
    });
    return pending.then(() => undefined);
  }
  take(workingDirectory: string): ReturnType<typeof loadResources> {
    const directory = resolve(workingDirectory),
      current = this.reserved;
    if (current?.directory === directory) {
      this.reserved = undefined;
      if (current.signature === this.signature(directory)) return current.pending;
    }
    return this.load(directory, this.agentDirectory, this.browserGuidance);
  }
  clear(): void {
    this.reserved = undefined;
  }
  private signature(directory: string): string {
    return [join(this.agentDirectory, "settings.json"), join(directory, ".pi", "settings.json")]
      .map((path) => {
        try {
          const info = statSync(path);
          return `${info.mtimeMs}:${info.size}`;
        } catch {
          return "missing";
        }
      })
      .join("|");
  }
}
