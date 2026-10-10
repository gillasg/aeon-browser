import { startStandaloneCore, acquireCoreLock } from "./core-startup.js";
import { reserveSupervisorOutput } from "./supervisor-output.js";
import { startCoreTransport } from "./core-transport.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { startDevHandshakeServer } from "./dev-harness.js";
import { createLocalFixtureRuntime } from "./dev-runtime.js";
import { createProductionRuntime } from "./production-runtime.js";
import { startNativeTransport } from "./native-transport.js";
import { readEnvironment } from "./environment.js";
import { NativeBootstrapResponseSchema, SUPPORTED_PROTOCOL_VERSION } from "@aeon/protocol";

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "--core") {
    await startStandaloneCore();
    return;
  }
  if (mode !== "--dev-handshake" && mode !== "--dev-chat" && mode !== "--managed-daemon") {
    process.stderr.write(
      "No production daemon entrypoint exists. Use --dev-handshake or the isolated --dev-chat fixture.\n",
    );
    process.exitCode = 1;
    return;
  }

  try {
    if (mode === "--dev-handshake") {
      const harness = await startDevHandshakeServer();
      process.stdout.write(`Aeon development handshake listening at ${harness.url}\n`);
      return;
    }
    if (mode === "--managed-daemon") {
      await runManagedDaemon();
      return;
    }
    await runLocalFixture();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown startup error.";
    process.stderr.write(`Aeon development mode failed: ${message}\n`);
    process.exitCode = 1;
  }
}

async function runManagedDaemon(): Promise<void> {
  const writeReply = reserveSupervisorOutput();
  if (readEnvironment("NATIVE_SUPERVISED") !== "1")
    throw new Error("Managed daemon startup requires the Native Messaging supervisor.");
  const dataDirectory = readEnvironment("NATIVE_DATA_DIR");
  const extensionOrigin = readEnvironment("NATIVE_EXTENSION_ORIGIN");
  if (
    !dataDirectory ||
    !extensionOrigin ||
    !/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin)
  )
    throw new Error("Managed daemon configuration is invalid.");

  const unlock = await acquireCoreLock(dataDirectory);
  let runtime: ReturnType<typeof createProductionRuntime> | undefined;
  let transport: Awaited<ReturnType<typeof startNativeTransport>> | undefined;
  let coreTransport: Awaited<ReturnType<typeof startCoreTransport>> | undefined;
  let input: ReturnType<typeof createInterface> | undefined;
  try {
    runtime = createProductionRuntime(dataDirectory);
    await runtime.ready;
    transport = await startNativeTransport(
      runtime.service,
      extensionOrigin,
      runtime.browserControl,
      runtime.threadCoordination,
      runtime.attention,
    );
    coreTransport = await startCoreTransport(
      dataDirectory,
      runtime.service,
      runtime.browserControl,
      runtime.threadCoordination,
      runtime.attention,
    );
    writeReply("AEON_DAEMON_READY\n");
    input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      if (line === "shutdown") break;
      writeReply(`${await handleSupervisorLine(line, transport)}\n`);
    }
  } finally {
    input?.close();
    try {
      await coreTransport?.close();
      await transport?.close();
      await runtime?.close();
    } finally {
      await unlock();
    }
  }
}

async function handleSupervisorLine(
  line: string,
  transport: Awaited<ReturnType<typeof startNativeTransport>>,
): Promise<string> {
  try {
    if (line.length > 32768) throw new Error("oversized supervisor line");
    const candidate = JSON.parse(Buffer.from(line, "base64").toString("utf8")) as unknown;
    const response = transport.handleBootstrapEnvelope(candidate);
    return Buffer.from(JSON.stringify(response), "utf8").toString("base64");
  } catch {
    const response = NativeBootstrapResponseSchema.parse({
      kind: "native.bootstrap.result",
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      ok: false,
      code: "BOOTSTRAP_UNAVAILABLE",
      retryable: true,
      supportedProtocolVersion: SUPPORTED_PROTOCOL_VERSION,
    });
    return Buffer.from(JSON.stringify(response), "utf8").toString("base64");
  }
}

async function runLocalFixture(): Promise<void> {
  const dataDirectory =
    process.env.AEON_DEV_DATA_DIR ??
    process.env.PIPPIN_DEV_DATA_DIR ??
    join(tmpdir(), "aeon-slice1-dev-chat");
  const runtime = createLocalFixtureRuntime(dataDirectory);
  await runtime.ready;
  const harness = await startDevHandshakeServer({
    chatService: runtime.service,
    threadCoordination: runtime.threadCoordination,
  });
  process.stdout.write(`Aeon local faux-model Chat fixture listening at ${harness.url}\n`);
  process.stdout.write(`Development data directory: ${dataDirectory}\n`);
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      await harness.close();
      await runtime.close();
      resolve();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  });
}

await main();
