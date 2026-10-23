import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export async function copyOnce(source: string, destination: string): Promise<string | null> {
  let sourceBytes: Buffer;
  try {
    sourceBytes = await readFile(source);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(destination, "wx", 0o600);
    await handle.writeFile(sourceBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  return destination;
}

export async function atomicWriteJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function existingMode(path: string): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (error) {
    if (isNotFound(error)) return 0o600;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
