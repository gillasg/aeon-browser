import { constants, lstatSync } from "node:fs";
import { chmod, lstat, mkdir, open, readlink } from "node:fs/promises";
import { isAbsolute, dirname, join, parse, relative, resolve, sep } from "node:path";

const DEFAULT_FIX = "Set AEON_DATA_DIR or BROWSERKIT_HOME to a directory you own with mode 700.";

export class UntrustedDirError extends Error {
  readonly fix: string;
  constructor(dir: string, reason: string, fix: string) {
    super(`Refusing ${dir}: ${reason}.`);
    this.name = "UntrustedDirError";
    this.fix = fix;
  }
}

export interface PrivateDirOptions {
  /** When false, a missing directory is left missing. An existing one is still checked. */
  create?: boolean;
  fix?: string;
  uid?: number;
}

/**
 * Makes sure `dir` is a real directory this user owns, mode 700, under parents owned by this
 * user or root. A loose directory this user already owns is chmodded to 700 and accepted.
 * A directory another user created, a symlink, or one under a non-sticky other-writable
 * parent is refused and left unchanged.
 */
export async function ensurePrivateDir(
  dir: string,
  options: PrivateDirOptions = {},
): Promise<void> {
  const fix = options.fix ?? DEFAULT_FIX;
  if (!dir) throw new UntrustedDirError(dir, "the path is empty", fix);
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    if (options.create !== false) await mkdir(dir, { recursive: true });
    return;
  }
  const uid = options.uid ?? process.getuid();
  const target = resolve(dir);
  await trustedParents(target, uid, fix, options.create !== false);
  await openOwned(target, uid, fix, options.create !== false);
}

/** Why a socket must not be connected to, or undefined when it is absent or ours. */
export function foreignSocket(path: string, uid = process.getuid?.()): string | undefined {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
  if (stats.isSymbolicLink()) return "the socket path is a symlink";
  if (!stats.isSocket()) return undefined;
  if (typeof uid === "number" && stats.uid !== uid)
    return `the socket is owned by uid ${stats.uid}, not ${uid}`;
  return undefined;
}

async function trustedParents(
  dir: string,
  uid: number,
  fix: string,
  create: boolean,
): Promise<void> {
  const root = parse(dir).root;
  let current = root;
  for (const part of relative(root, dirname(dir)).split(sep)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    current = await trustEntry(join(current, part), dir, uid, fix, create, 0);
  }
}

async function trustEntry(
  entry: string,
  target: string,
  uid: number,
  fix: string,
  create: boolean,
  depth: number,
): Promise<string> {
  if (depth > 8) throw new UntrustedDirError(target, `${entry} has too many symbolic links`, fix);
  const stats = await readEntry(entry, create);
  if (!stats) return entry;
  if (stats.isSymbolicLink()) return followLink(entry, target, uid, fix, depth);
  if (!stats.isDirectory()) throw new UntrustedDirError(target, `${entry} is not a directory`, fix);
  if (stats.uid !== 0 && stats.uid !== uid)
    throw new UntrustedDirError(
      target,
      `${entry} is owned by uid ${stats.uid}, not ${uid} or root`,
      fix,
    );
  if (writableByOthers(stats, uid))
    throw new UntrustedDirError(
      target,
      `${entry} is writable by others without the sticky bit`,
      fix,
    );
  return entry;
}

/**
 * A parent others can write to without the sticky bit lets them swap the child. Group write is
 * fine when this user owns the directory and the group is their own primary group (the Linux
 * default: umask 002 with a private per-user group makes ~/.local 775).
 */
function writableByOthers(stats: { uid: number; gid: number; mode: number }, uid: number): boolean {
  if ((stats.mode & 0o1000) !== 0) return false;
  if ((stats.mode & 0o002) !== 0) return true;
  if ((stats.mode & 0o020) === 0) return false;
  const ownGroup = stats.uid === uid && stats.gid === process.getgid?.();
  return !ownGroup;
}

async function readEntry(entry: string, create: boolean) {
  try {
    return await lstat(entry);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
    if (!create) return undefined;
    await mkdir(entry, { mode: 0o700 }).catch((mkdirError: unknown) => {
      if (codeOf(mkdirError) !== "EEXIST") throw mkdirError;
    });
    await chmodOwned(entry);
    return lstat(entry);
  }
}

async function followLink(
  entry: string,
  target: string,
  uid: number,
  fix: string,
  depth: number,
): Promise<string> {
  const link = await readlink(entry);
  const next = isAbsolute(link) ? link : resolve(dirname(entry), link);
  await trustedParents(join(next, "child"), uid, fix, false);
  return trustEntry(next, target, uid, fix, false, depth + 1);
}

async function openOwned(dir: string, uid: number, fix: string, create: boolean): Promise<void> {
  const looked = await lookAt(dir, fix, create);
  if (!looked) return;
  refuseUnowned(dir, looked, uid, fix);
  const handle = await openDirectory(dir, fix);
  try {
    const stats = await handle.stat();
    if (stats.ino !== looked.ino || stats.dev !== looked.dev)
      throw new UntrustedDirError(dir, "it is not a real directory", fix);
    refuseUnowned(dir, stats, uid, fix);
    await tightenOwned(dir, handle, stats.mode);
  } finally {
    await handle.close();
  }
}

function refuseUnowned(
  dir: string,
  stats: { isSymbolicLink(): boolean; isDirectory(): boolean; uid: number },
  uid: number,
  fix: string,
): void {
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new UntrustedDirError(dir, "it is not a real directory", fix);
  if (stats.uid !== uid)
    throw new UntrustedDirError(dir, `it is owned by uid ${stats.uid}, not ${uid}`, fix);
}

/** An owned directory with group or other bits becomes 700. A foreign one is never chmodded. */
async function tightenOwned(
  dir: string,
  handle: { chmod(mode: number): Promise<void> },
  mode: number,
): Promise<void> {
  const bits = mode & 0o777;
  if ((bits & 0o077) === 0) return;
  await handle.chmod(0o700);
  process.stderr.write(`Tightened ${dir} from mode ${bits.toString(8)} to 700.\n`);
}

async function lookAt(dir: string, fix: string, create: boolean) {
  try {
    return await lstat(dir);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
    if (!create) return undefined;
    await mkdir(dir, { mode: 0o700 }).catch((mkdirError: unknown) => {
      if (codeOf(mkdirError) !== "EEXIST") throw mkdirError;
    });
    await chmodOwned(dir);
    return lstat(dir);
  }
}

async function openDirectory(dir: string, fix: string) {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    return await open(dir, flags);
  } catch (error) {
    const code = codeOf(error);
    if (code === "ELOOP" || code === "ENOTDIR" || code === "EACCES")
      throw new UntrustedDirError(dir, "it is not a real directory", fix);
    throw error;
  }
}

/** chmod 700 only for a directory this call just created and this user owns. */
async function chmodOwned(entry: string): Promise<void> {
  const stats = await lstat(entry);
  if (stats.uid === process.getuid?.()) await chmod(entry, 0o700);
}

function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}
