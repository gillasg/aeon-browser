import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";

// The same app root the daemon and the CLI resolve (see @graft/location). Paths are computed here
// too because the native host runs before/without the TypeScript build.

export function appRoot(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const path = platform === "win32" ? win32 : posix;
  if (platform === "win32")
    return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Graft");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Graft");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "graft");
}

export function dataDirectory(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const configured = env.GRAFT_DATA_DIR;
  if (configured)
    return path.resolve(configured.replace(/^~(?=$|[\\/])/, options.home ?? homedir()));
  return path.join(appRoot(options), "data");
}

/**
 * The directory that holds the bootstrap socket: the per-user runtime directory on Linux, and a
 * private directory this user owns on macOS. Never a shared, predictable file in /tmp: another
 * local user must not be able to create the path first and answer as the supervisor.
 */
export function runtimeDirectory(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return undefined;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  return posixRuntimeDirectory(platform, env, uid);
}

/** An explicit parent wins on every POSIX OS; the same ownership checks apply inside it. */
function posixRuntimeDirectory(platform, env, uid) {
  if (env.GRAFT_RUNTIME_DIR) return posix.join(env.GRAFT_RUNTIME_DIR, "graft");
  if (platform === "linux" && env.XDG_RUNTIME_DIR) return posix.join(env.XDG_RUNTIME_DIR, "graft");
  if (platform === "darwin") {
    const mac = macRuntimeDirectory(env, uid);
    if (mac) return mac;
  }
  return posix.join("/tmp", `graft-${uid ?? "user"}`);
}

/**
 * macOS gives each user a private temp dir (confstr _CS_DARWIN_USER_TEMP_DIR), exposed by Node as
 * os.tmpdir()/$TMPDIR. The Chrome-launched host and the launchd supervisor resolve the same path,
 * so they agree on the socket. A shared /tmp is not good enough; fall back to /tmp/graft-<uid>.
 */
function macRuntimeDirectory(env, uid) {
  const base = env.TMPDIR ?? tmpdir();
  return privateTempDir(base, uid) ? posix.join(base, "graft") : undefined;
}

/** True when `base` is this user's own temp dir and safe to hold the socket directory. */
function privateTempDir(base, uid) {
  if (typeof base !== "string" || !posix.isAbsolute(base)) return false;
  if (base === "/tmp" || base === "/private/tmp") return false;
  try {
    const stats = lstatSync(base);
    return (
      stats.isDirectory() &&
      !stats.isSymbolicLink() &&
      (typeof uid !== "number" || stats.uid === uid)
    );
  } catch {
    return false;
  }
}

function thisUid(options = {}) {
  return options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
}

function untrusted(path, why) {
  return Object.assign(new Error(`Refusing ${path}: ${why}`), { code: "EUNTRUSTED_SOCKET" });
}

/**
 * Creates the socket directory with mode 0700 and verifies it is a real directory this user owns
 * with no group or other access. A pre-created directory by another user (or a symlink) is a
 * refusal, never something we trust and bind inside.
 */
export function ensureSocketDirectory(directory, options = {}) {
  let stats;
  try {
    stats = lstatSync(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    stats = lstatSync(directory);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw untrusted(directory, "the socket directory is not a real directory");
  const uid = thisUid(options);
  if (typeof uid === "number" && stats.uid !== uid)
    throw untrusted(directory, `the socket directory is owned by uid ${stats.uid}, not ${uid}`);
  if ((stats.mode & 0o077) !== 0)
    throw untrusted(
      directory,
      `the socket directory is mode ${(stats.mode & 0o777).toString(8)}, not 700`,
    );
  return directory;
}

/** Why a socket path is not safe to connect to, or undefined when this user owns the socket. */
export function socketOwnerProblem(path, options = {}) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return "the socket does not exist";
    throw error;
  }
  if (!stats.isSocket()) return "the path is not a socket";
  const uid = thisUid(options);
  if (typeof uid === "number" && stats.uid !== uid)
    return `the socket is owned by uid ${stats.uid}, not ${uid}`;
  return undefined;
}

/** Throws before a connect when the socket belongs to another local user. */
export function verifySocketOwner(path, options = {}) {
  const problem = socketOwnerProblem(path, options);
  if (problem) throw untrusted(path, problem);
  return path;
}

/**
 * Unix socket paths are limited to ~104 bytes, so the socket is short and per-user: under
 * $XDG_RUNTIME_DIR on Linux, else /tmp/graft-<uid> (created 0700 and owner-checked). 0600 keeps
 * the bound socket owner-only; the directory keeps another user from pre-binding the path.
 */
export function socketPath(options = {}) {
  const path = options.platform === "win32" ? win32 : posix;
  const uid = thisUid(options);
  const root = path.resolve(appRoot(options));
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const user = uid ?? "user";
  const directory = runtimeDirectory({ ...options, uid });
  // Windows keeps the legacy short name: named pipes are not files another user can pre-create.
  if (!directory) return path.join("/tmp", `graft-${user}-${hash}.sock`);
  const socket = path.join(directory, `${hash}.sock`);
  // A pathological $XDG_RUNTIME_DIR must not push the socket over the ~104-byte limit: fall back
  // to the private per-user directory in /tmp instead.
  if (socket.length < 104) return socket;
  return path.join("/tmp", `graft-${user}`, `${hash}.sock`);
}

export function hostPaths(options = {}) {
  const path = options.platform === "win32" ? win32 : posix;
  const root = appRoot(options);
  return {
    root,
    config: path.join(root, "host-config.json"),
    log: path.join(root, "daemon-supervisor.log"),
    status: path.join(root, "daemon-supervisor-status.json"),
    socket: socketPath(options),
    launcher: path.join(root, "graft-native-host"),
    data: dataDirectory(options),
  };
}
