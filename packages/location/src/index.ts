import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Where Aeon keeps its configuration and data on this OS. */
export interface AeonLocationOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * The per-user Aeon directory: `%LOCALAPPDATA%\Aeon` on Windows (unchanged), Application
 * Support on macOS, and the XDG data directory on Linux.
 */
export function aeonAppRoot(options: AeonLocationOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Aeon");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Aeon");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "aeon");
}

/** The daemon's data directory, beside the config and overridable with `AEON_DATA_DIR`. */
export function aeonDataDirectory(options: AeonLocationOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env.AEON_DATA_DIR;
  if (configured) return resolve(expandHome(configured, options.home ?? homedir()));
  return join(aeonAppRoot(options), "data");
}

function expandHome(path: string, home: string): string {
  return path.replace(/^~(?=$|[\\/])/, home);
}
