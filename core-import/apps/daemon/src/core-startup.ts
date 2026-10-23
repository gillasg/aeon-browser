import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createProductionRuntime } from "./production-runtime.js";
import { startCoreTransport } from "./core-transport.js";

export async function acquireCoreLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const identity = createHash("sha256").update(resolve(directory).toLowerCase()).digest("hex");
  const address =
    process.platform === "win32"
      ? "\\\\.\\pipe\\aeon-core-owner-" + identity
      : join(directory, "core-owner.sock");
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolveReady();
    });
  });
  return async () => {
    await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  };
}

export async function startStandaloneCore(): Promise<void> {
  const installedRoot = join(process.env.LOCALAPPDATA ?? "", "Aeon");
  const directory = resolve(process.env.AEON_CORE_DATA_DIR ?? join(installedRoot, "data"));
  const unlock = await acquireCoreLock(directory);
  let runtime: ReturnType<typeof createProductionRuntime> | undefined;
  let core: Awaited<ReturnType<typeof startCoreTransport>> | undefined;
  try {
    runtime = createProductionRuntime(directory);
    await runtime.ready;
    core = await startCoreTransport(
      directory,
      runtime.service,
      runtime.browserControl,
      runtime.threadCoordination,
      runtime.attention,
    );
    const origin = process.env.AEON_BROWSER_ORIGIN;
    if (origin)
      throw new Error(
        "Browser bootstrap requires the installed native supervisor; omit AEON_BROWSER_ORIGIN.",
      );
    process.stdout.write("Core ready. Native clients can discover it in the data directory.\n");
    await new Promise<void>((resolveStop) => {
      process.once("SIGINT", resolveStop);
      process.once("SIGTERM", resolveStop);
    });
  } finally {
    try {
      await core?.close();
      await runtime?.close();
    } finally {
      await unlock();
    }
  }
}
