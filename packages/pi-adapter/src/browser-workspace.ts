import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
  rename,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative, dirname, isAbsolute, extname, join, basename, sep } from "node:path";
import { randomUUID } from "node:crypto";
interface Request {
  workspace: string;
  name: string;
  value?: unknown;
  base64?: boolean;
}
export function isWorkspaceRequest(value: unknown): value is Request {
  return typeof value === "object" && value !== null && "workspace" in value;
}
export async function workspaceCall(root: string, request: Request): Promise<unknown> {
  if (request.workspace === "list") return await listWorkspace(root, request.name);
  if (request.workspace === "screenshot" || request.workspace === "screenshot-append")
    return saveScreenshot(root, request, request.workspace === "screenshot-append");
  const path = await workspacePath(root, request.name);
  const read = await readAction(path, request);
  if (read !== undefined) return read;
  return await writeAction(root, path, request);
}

async function listWorkspace(root: string, name: string): Promise<unknown> {
  const base = await realpath(root).catch(() => root);
  const folder = name ? await workspacePath(root, name) : base;
  const entries = await readdir(folder, { withFileTypes: true });
  return {
    name: name || ".",
    entries: entries
      .slice(0, 500)
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
      .sort(
        (left, right) =>
          Number(right.dir) - Number(left.dir) || left.name.localeCompare(right.name),
      ),
  };
}

/** The read-only actions; undefined means this request is a write. */
async function readAction(path: string, request: Request): Promise<unknown> {
  if (request.workspace === "read")
    return { name: request.name, text: await boundedRead(path, true) };
  if (request.workspace === "load") return JSON.parse(await boundedRead(path, true));
  if (request.workspace === "loadHelper") return boundedRead(path, true);
  if (request.workspace === "image") return await imageWorkspace(path);
  return undefined;
}

async function imageWorkspace(path: string): Promise<unknown> {
  const types: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  const mimeType = types[extname(path).toLowerCase()];
  if (!mimeType) throw new Error("Unsupported image type");
  const bytes = await boundedRead(path);
  return { kind: "screenshot", screenshotId: randomUUID(), dataBase64: bytes, mimeType, path };
}

async function writeAction(root: string, path: string, request: Request): Promise<unknown> {
  const data = request.workspace === "checkpoint" ? JSON.stringify(request.value) : request.value;
  if (typeof data !== "string" && !Array.isArray(data))
    throw new Error("Workspace output must be text or bytes");
  const bytes = Array.isArray(data)
    ? Buffer.from(data)
    : Buffer.from(data, request.base64 ? "base64" : "utf8");
  if (bytes.length > 16_000_000) throw new Error("Artifact exceeded 16 MB; split it into files");
  await mkdir(dirname(path), { recursive: true });
  // Revalidate after creating parents; do not write through a workspace symlink.
  await workspacePath(root, request.name);
  await writeWorkspaceFile(path, request.workspace, bytes);
  return { path, bytes: bytes.length, checkpoint: request.workspace === "checkpoint" };
}
async function writeWorkspaceFile(path: string, action: string, bytes: Buffer): Promise<void> {
  // Large artifacts arrive in pieces: the first creates the file, the rest append to it.
  if (action === "append") {
    if ((await stat(path)).size + bytes.length > 64_000_000)
      throw new Error("Artifact exceeded 64 MB; split it into files");
    await appendFile(path, bytes);
  } else if (action !== "checkpoint") {
    await writeFile(path, bytes, { flag: "wx" });
  } else {
    const temp = join(dirname(path), ".checkpoint-" + randomUUID());
    try {
      await writeFile(temp, bytes, { flag: "wx" });
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
}
async function boundedRead(path: string, text = false): Promise<string> {
  if ((await stat(path)).size > (text ? 16_000_000 : 4_000_000))
    throw new Error("File exceeds read limit");
  return (await readFile(path)).toString(text ? "utf8" : "base64");
}
async function workspacePath(root: string, name: string): Promise<string> {
  if (!name || isAbsolute(name)) throw new Error("Use a relative workspace filename");
  await mkdir(root, { recursive: true });
  const base = await realpath(root),
    path = resolve(base, name),
    rel = relative(base, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("File is outside the workspace");
  let existing = path;
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existing = dirname(existing);
    }
  }
  const actual = relative(base, existing);
  if (actual.startsWith("..") || isAbsolute(actual))
    throw new Error("Workspace symlink escapes its root");
  return path;
}
interface ShotPlace {
  path?: string;
  relative?: string;
  base?: string;
  note?: string;
}

/** The [did] line for a workspace write. A screenshot names the absolute file that was written. */
export function workspaceDid(action: string, result: unknown): string {
  if (action !== "screenshot") return action;
  const saved = shotPath(result);
  return saved ? `screenshot ${saved}` : action;
}

/** Record a workspace write on the cell. Chunks after the first screenshot add no second line. */
export function noteWorkspaceStep(
  steps: Record<string, unknown>[],
  request: { workspace: string },
  result: unknown,
): void {
  if (request.workspace === "screenshot-append") return;
  steps.push({ action: workspaceDid(request.workspace, result), result, workspace: true });
}

function shotPath(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const path = (result as { path?: unknown }).path;
  return typeof path === "string" ? path : "";
}

function contained(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function screensName(name: string): string {
  const cleaned = name.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  if (!cleaned || cleaned.split("/").includes(".."))
    throw new Error("File is outside the workspace");
  return cleaned.startsWith("screens/") ? cleaned : `screens/${cleaned}`;
}

async function realBase(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

async function matchingRoot(bases: readonly string[], target: string): Promise<string | undefined> {
  for (const base of bases) {
    if (contained(base, target)) return realBase(base);
  }
  return undefined;
}

async function allowedBase(root: string, target: string): Promise<string | undefined> {
  const session = resolve(root);
  const sessionHit = await matchingRoot([session, await realBase(session)], target);
  if (sessionHit) return sessionHit;
  const temps = new Set<string>([resolve(tmpdir()), "/tmp"].map((seed) => resolve(seed)));
  for (const seed of [...temps]) temps.add(await realBase(seed));
  return matchingRoot([...temps], target);
}

function shotLeaf(asked: string): string {
  const leaf = basename(asked)
    .replace(/[^\w.-]+/g, "_")
    .replace(/^\.+/, "");
  return leaf || "shot.png";
}

async function placeAbsolute(root: string, asked: string): Promise<ShotPlace> {
  const target = resolve(asked);
  const base = await allowedBase(root, target);
  if (base) return { path: target, base };
  return {
    relative: screensName(shotLeaf(asked)),
    note: `saved in the session screens folder; ${asked} is outside the session folder and the temp directory`,
  };
}

async function placeScreenshot(root: string, name: string): Promise<ShotPlace> {
  const asked = name.trim();
  if (!asked) return { relative: `screens/${Date.now()}.png` };
  if (isAbsolute(asked)) return placeAbsolute(root, asked);
  return { relative: screensName(asked.replace(/\\/g, "/")) };
}

function shotBytes(request: Request): Buffer {
  const data = request.value;
  if (typeof data !== "string" && !Array.isArray(data))
    throw new Error("Workspace output must be text or bytes");
  const bytes = Array.isArray(data)
    ? Buffer.from(data)
    : Buffer.from(data, request.base64 ? "base64" : "utf8");
  if (bytes.length > 16_000_000) throw new Error("Artifact exceeded 16 MB; split it into files");
  return bytes;
}

async function linkTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(dirname(path), await readlink(path));
  }
}

async function guardLink(base: string, path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isSymbolicLink()) return;
  if (!contained(base, await linkTarget(path)))
    throw new Error("Workspace symlink escapes its root");
}

async function nearestExisting(base: string, start: string): Promise<string> {
  let cursor = start;
  while (true) {
    const found = await anchored(base, cursor);
    if (found) return found;
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("File is outside the workspace");
    cursor = parent;
  }
}

async function anchored(base: string, path: string): Promise<string | undefined> {
  try {
    await guardLink(base, path);
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

async function confirmInside(placed: ShotPlace): Promise<void> {
  if (!placed.path || !placed.base) throw new Error("File is outside the workspace");
  const real = await nearestExisting(placed.base, placed.path);
  if (!contained(placed.base, real)) throw new Error("Workspace symlink escapes its root");
}

async function writeRelative(
  root: string,
  placed: ShotPlace,
  bytes: Buffer,
  action: string,
): Promise<unknown> {
  if (!placed.relative) throw new Error("File is outside the workspace");
  const path = await workspacePath(root, placed.relative);
  await mkdir(dirname(path), { recursive: true });
  await workspacePath(root, placed.relative);
  await writeWorkspaceFile(path, action, bytes);
  return placed.note
    ? { path, bytes: bytes.length, note: placed.note }
    : { path, bytes: bytes.length };
}

async function writePlaced(
  root: string,
  placed: ShotPlace,
  bytes: Buffer,
  append: boolean,
): Promise<unknown> {
  const action = append ? "append" : "screenshot";
  if (placed.relative) return writeRelative(root, placed, bytes, action);
  if (!placed.path) throw new Error("File is outside the workspace");
  await confirmInside(placed);
  await mkdir(dirname(placed.path), { recursive: true });
  await confirmInside(placed);
  await writeWorkspaceFile(placed.path, action, bytes);
  return { path: placed.path, bytes: bytes.length };
}

async function saveScreenshot(root: string, request: Request, append: boolean): Promise<unknown> {
  const placed = await placeScreenshot(root, String(request.name ?? ""));
  return writePlaced(root, placed, shotBytes(request), append);
}

/**
 * Resolves upload sources inside the workspace only. The realpath must stay under the workspace's
 * own realpath, so an absolute host path, a `../` walk or a symlink that leads out is refused; a
 * file from elsewhere must be copied into the workspace first, a step the user can see.
 */
export async function validateUploadFiles(files: string[], root: string): Promise<string[]> {
  const realRoot = await realpath(resolve(root));
  return Promise.all(
    files.map(async (file) => {
      let path: string;
      try {
        path = await realpath(resolve(realRoot, file));
      } catch {
        throw new Error(`UPLOAD_OUTSIDE_WORKSPACE: ${file} is not a file in the workspace`);
      }
      if (!contained(realRoot, path))
        throw new Error(
          `UPLOAD_OUTSIDE_WORKSPACE: ${file} is outside the workspace; copy it into the workspace first`,
        );
      if (!(await stat(path)).isFile()) throw new Error("Upload source is not a regular file");
      return path;
    }),
  );
}

/**
 * Workspace files and upload checks for a cell with no chat around it (`aeon repl`, CLI
 * commands): the same answers a chat's cells get, rooted in `root`. Undefined when the request
 * is neither, so the caller can try its other handlers.
 */
export function cellWorkspaceCall(request: unknown, root: string): Promise<unknown> | undefined {
  if (isWorkspaceRequest(request))
    return mkdir(root, { recursive: true }).then(() => workspaceCall(root, request));
  const upload = (request as { validateUpload?: unknown } | null)?.validateUpload;
  if (Array.isArray(upload))
    return mkdir(root, { recursive: true }).then(() =>
      validateUploadFiles(upload.map(String), root),
    );
  return undefined;
}
