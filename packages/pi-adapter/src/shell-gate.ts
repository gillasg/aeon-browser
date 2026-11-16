import {
  createBashToolDefinition,
  defineTool,
  type BashSpawnContext,
} from "@earendil-works/pi-coding-agent";
import { shellProxyEnv } from "@browserkit/tools/shell-proxy";

// Bash inherits a proxy that enforces the user's blocked sites, including redirects.

let proxyEnv: Record<string, string> | undefined;

export async function startShellGate(): Promise<void> {
  proxyEnv ??= await shellProxyEnv();
}

export function gateShellSpawn(context: BashSpawnContext): BashSpawnContext {
  return proxyEnv ? { ...context, env: { ...context.env, ...proxyEnv } } : context;
}

interface ShellSettings {
  getShellCommandPrefix(): string | undefined;
  getShellPath(): string | undefined;
}

/** The built-in bash tool, with the gate on every command. */
export function gatedBashTool(cwd: string, settings: ShellSettings): ReturnType<typeof defineTool> {
  const commandPrefix = settings.getShellCommandPrefix();
  const shellPath = settings.getShellPath();
  return defineTool(
    createBashToolDefinition(cwd, {
      ...(commandPrefix ? { commandPrefix } : {}),
      ...(shellPath ? { shellPath } : {}),
      spawnHook: gateShellSpawn,
    }),
  );
}
