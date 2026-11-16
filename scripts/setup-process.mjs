import { execFileSync } from "node:child_process";

const WINDOWS_SHIM = /\.(?:cmd|bat)$/i;

/** Windows installs pnpm as a .cmd shim; elsewhere it is a normal executable. */
export function pnpmCommand(platform = process.platform) {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

/**
 * Runs one setup command without a shell, so a checkout under "Application Support" or any other
 * path with spaces reaches the program as one argument. A Windows .cmd shim cannot start on its
 * own; cmd.exe is needed for that one case, and setup only passes fixed flags through it.
 */
export function runCommand(command, commandArgs, options = {}) {
  const { platform = process.platform, env = process.env, ...execOptions } = options;
  if (platform === "win32" && WINDOWS_SHIM.test(command)) {
    const shell = env.ComSpec || "cmd.exe";
    return execFileSync(shell, ["/d", "/s", "/c", command, ...commandArgs], execOptions);
  }
  return execFileSync(command, commandArgs, execOptions);
}
