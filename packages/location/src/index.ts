import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export { ensurePrivateDir, foreignSocket, UntrustedDirError } from "./private-dir.js";
export type { PrivateDirOptions } from "./private-dir.js";

/** Where Graft keeps its configuration and data on this OS. */
export interface GraftLocationOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * The per-user Graft directory: `%LOCALAPPDATA%\Graft` on Windows (unchanged), Application
 * Support on macOS, and the XDG data directory on Linux.
 */
export function graftAppRoot(options: GraftLocationOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const path = platform === "win32" ? win32 : posix;
  if (platform === "win32")
    return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Graft");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Graft");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "graft");
}

/** The daemon's data directory, beside the config and overridable with `GRAFT_DATA_DIR`. */
export function graftDataDirectory(options: GraftLocationOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const configured = env.GRAFT_DATA_DIR;
  if (configured) return path.resolve(expandHome(configured, options.home ?? homedir()));
  return path.join(graftAppRoot(options), "data");
}

function expandHome(path: string, home: string): string {
  return path.replace(/^~(?=$|[\\/])/, home);
}
export * from "./event-log.js";
