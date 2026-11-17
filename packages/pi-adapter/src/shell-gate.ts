import {
  createBashToolDefinition,
  defineTool,
  type BashSpawnContext,
} from "@earendil-works/pi-coding-agent";
import { shellProxyEnv } from "@browserkit/tools/shell-proxy";

// Bash inherits a proxy that enforces the user's blocked sites, including redirects, for clients
// that honour proxy environment variables. A command that unsets/overrides them, or a program that
// ignores them (raw sockets, PowerShell/WinHTTP, many native clients), is NOT gated: use browser
// tools for blocked sites. This is a convenience gate, not a network sandbox.

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
