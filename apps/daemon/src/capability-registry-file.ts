import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { CapabilityRegistryFile } from "@pippin/domain";

export async function atomicWrite(path: string, registry: CapabilityRegistryFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function withRegistryLock<T>(
  locks: Map<string, Promise<void>>,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get("registry") ?? Promise.resolve();
  let release = (): void => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => next);
  locks.set("registry", tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get("registry") === tail) locks.delete("registry");
  }
}
