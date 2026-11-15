import { createHash } from "node:crypto";
import { createServer, connect } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { aeonDataDirectory } from "@aeon/location";
import { createProductionRuntime } from "./production-runtime.js";
import { startCoreTransport } from "./core-transport.js";

export async function acquireCoreLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const identity = createHash("sha256").update(resolve(directory).toLowerCase()).digest("hex");
  const address =
    process.platform === "win32"
      ? "\\\\.\\pipe\\aeon-core-owner-" + identity
      : join(directory, "core-owner.sock");
  if (process.platform !== "win32") await clearStaleCoreSocket(address);
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
    // A Unix socket file outlives its listener; a killed daemon would otherwise block every
    // restart with EADDRINUSE.
    if (process.platform !== "win32") await unlink(address).catch(() => undefined);
  };
}

/** A socket that refuses connections is a dead daemon's leftover; a live one is the single owner. */
async function clearStaleCoreSocket(address: string): Promise<void> {
  if (!existsSync(address)) return;
  if (await acceptsConnections(address))
    throw Object.assign(
      new Error("Another Aeon core already owns the data directory (EADDRINUSE)."),
      { code: "EADDRINUSE" },
    );
  await unlink(address).catch(() => undefined);
}

function acceptsConnections(address: string): Promise<boolean> {
  return new Promise((resolveConnected) => {
    const socket = connect(address);
    const timer = setTimeout(() => {
      socket.destroy();
      resolveConnected(false);
    }, 500);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveConnected(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveConnected(false);
    });
  });
}

export async function startStandaloneCore(): Promise<void> {
  const directory = resolve(process.env.AEON_CORE_DATA_DIR ?? aeonDataDirectory());
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
    runtime.warm();
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
