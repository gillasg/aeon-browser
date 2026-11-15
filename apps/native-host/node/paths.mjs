import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The same app root the daemon and the CLI resolve (see @aeon/location). Paths are computed here
// too because the native host runs before/without the TypeScript build.

export function appRoot(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Aeon");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Aeon");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "aeon");
}

export function dataDirectory(options = {}) {
  const env = options.env ?? process.env;
  const configured = env.AEON_DATA_DIR;
  if (configured) return resolve(configured.replace(/^~(?=$|[\\/])/, options.home ?? homedir()));
  return join(appRoot(options), "data");
}

/**
 * Unix socket paths are limited to ~104 bytes, and a home under a sandboxed temp folder is
 * already close to that. The socket is therefore short and per-app-root in /tmp, never in the
 * app folder; 0600 keeps it owner-only after the supervisor binds it.
 */
export function socketPath(options = {}) {
  const root = resolve(appRoot(options));
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const user = typeof process.getuid === "function" ? process.getuid() : "user";
  return join("/tmp", `aeon-${user}-${hash}.sock`);
}

export function hostPaths(options = {}) {
  const root = appRoot(options);
  return {
    root,
    config: join(root, "host-config.json"),
    log: join(root, "daemon-supervisor.log"),
    status: join(root, "daemon-supervisor-status.json"),
    socket: socketPath(options),
    launcher: join(root, "aeon-native-host"),
    data: dataDirectory(options),
  };
}
