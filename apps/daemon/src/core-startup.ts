import { createHash } from "node:crypto";
import { createServer, connect } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  aeonDataDirectory,
  ensurePrivateDir,
  foreignSocket,
  UntrustedDirError,
} from "@aeon/location";
import { createProductionRuntime } from "./production-runtime.js";
import { startCoreTransport } from "./core-transport.js";
import { startSessionKeepalive, type SessionKeepalive } from "./session-keepalive.js";

export async function acquireCoreLock(directory: string): Promise<() => Promise<void>> {
  const fix = "Set AEON_DATA_DIR to a directory you own with mode 700.";
  if (process.platform === "win32") await mkdir(directory, { recursive: true });
  else await ensurePrivateDir(directory, { fix });
  const identity = createHash("sha256").update(resolve(directory).toLowerCase()).digest("hex");
  const address =
    process.platform === "win32"
      ? "\\\\.\\pipe\\aeon-core-owner-" + identity
      : join(directory, "core-owner.sock");
  if (process.platform !== "win32") await claimCoreSocket(address, fix);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolveReady();
    });
  });
  return async () => {
    // On Unix, closing the server removes its own socket path; a second daemon that binds the
    // path afterwards must keep it. Do not unlink here: the window after close is exactly when a
    // new owner can appear.
    await new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));
  };
}

/** A foreign socket is refused before connect. A dead file is removed. A live owner blocks the start. */
async function claimCoreSocket(address: string, fix: string): Promise<void> {
  const problem = foreignSocket(address);
  if (problem) throw new UntrustedDirError(address, problem, fix);
  await clearStaleCoreSocket(address);
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
  let keepalive: SessionKeepalive | undefined;
  try {
    runtime = createProductionRuntime(directory);
    await runtime.ready;
    const activity = runtime.activity;
    core = await startCoreTransport(
      directory,
      runtime.service,
      runtime.browserControl,
      runtime.threadCoordination,
      runtime.attention,
      activity,
    );
    const origin = process.env.AEON_BROWSER_ORIGIN;
    if (origin)
      throw new Error(
        "Browser bootstrap requires the installed native supervisor; omit AEON_BROWSER_ORIGIN.",
      );
    process.stdout.write("Core ready. Native clients can discover it in the data directory.\n");
    runtime.warm();
    keepalive = await startSessionKeepalive(directory);
    await new Promise<void>((resolveStop) => {
      process.once("SIGINT", resolveStop);
      process.once("SIGTERM", resolveStop);
    });
  } finally {
    try {
      keepalive?.stop();
      await core?.close();
      await runtime?.close();
    } finally {
      await unlock();
    }
  }
}
