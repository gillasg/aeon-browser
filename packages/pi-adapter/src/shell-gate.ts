import {
  createBashToolDefinition,
  defineTool,
  type BashSpawnContext,
} from "@earendil-works/pi-coding-agent";
import { shellProxyEnv } from "@browserkit/tools/shell-proxy";
import { detectSandboxBackend, scrubSandboxEnv, wrapSandboxedCommand } from "./os-sandbox.js";

// Bash inherits a proxy that enforces the user's blocked sites, including redirects, for clients
// that honour proxy environment variables. A command that unsets/overrides them, or a program that
// ignores them (raw sockets, PowerShell/WinHTTP, many native clients), is NOT gated: use browser
// tools for blocked sites. This is a convenience gate, not a network sandbox.

let proxyEnv: Record<string, string> | undefined;

export async function startShellGate(): Promise<void> {
  proxyEnv ??= await shellProxyEnv();
}

/** Secrets out of the environment, the proxy in, and the kernel sandbox around the command. */
export function gateShellSpawn(context: BashSpawnContext): BashSpawnContext {
  const env = { ...scrubSandboxEnv(context.env), ...proxyEnv };
  const status = detectSandboxBackend({ env: process.env });
  const command = status.active
    ? wrapSandboxedCommand(context.command, { cwd: context.cwd, status })
    : context.command;
  return { ...context, command, env };
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
