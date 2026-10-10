import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  bindPiExtensions,
  createPiResourceLoader,
  reloadPiResources,
  enablePiNativeDefaultTools,
} from "../dist/sdk-resources.js";
import { createLocalFixtureModel } from "../dist/fixture-model.js";
import { ExtensionUiBridge } from "../dist/extension-ui-bridge.js";
import { wrapPiSession } from "../dist/session-projection.js";

test("isolated SDK sessions load Pi built-ins and dispatch registered slash commands", async (t) => {
  const { workingDirectory, agentDirectory, settingsManager, commandArguments, resourceLoader } =
    await prepareNativeExtensionSpikeCase1Stage1(t);
  const { session } = await verifyNativeExtensionSpikeCase1Stage2(
    t,
    workingDirectory,
    agentDirectory,
    settingsManager,
    resourceLoader,
  );
  await verifyNativeExtensionSpikeCase1Stage3(commandArguments, session);
});

test("an unanswered Pi extension dialog sets needs_attention until its exact request resolves", async (t) => {
  const {
    workingDirectory,
    agentDirectory,
    settingsManager,
    dialogCommandCalls,
    resourceLoader,
    fixture,
    chatId,
    activationId,
    manager,
  } = await prepareNativeExtensionSpikeCase2Stage1(t);
  const { session, handle, events, pendingCommand } = await verifyNativeExtensionSpikeCase2Stage2(
    t,
    workingDirectory,
    agentDirectory,
    settingsManager,
    resourceLoader,
    fixture,
    chatId,
    activationId,
    manager,
  );
  await verifyNativeExtensionSpikeCase2Stage3(
    dialogCommandCalls,
    session,
    handle,
    events,
    pendingCommand,
  );
});

function expectedContextUsage(usage) {
  if (!usage || !Number.isSafeInteger(usage.contextWindow) || usage.contextWindow <= 0) return null;
  const tokens = Number.isSafeInteger(usage.tokens) && usage.tokens >= 0 ? usage.tokens : null;
  const percent = Number.isFinite(usage.percent) && usage.percent >= 0 ? usage.percent : null;
  return {
    tokens,
    availableTokens: tokens === null ? null : Math.max(0, usage.contextWindow - tokens),
    contextWindow: usage.contextWindow,
    percent,
  };
}

async function waitFor(predicate, description = "the Pi extension dialog") {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function prepareNativeExtensionSpikeCase1Stage1(t) {
  const root = await mkdtemp(join(tmpdir(), "aeon-pi-extension-spike-"));
  const workingDirectory = join(root, "project");
  const agentDirectory = join(root, "pi-agent");
  await Promise.all([
    mkdir(workingDirectory, { recursive: true }),
    mkdir(agentDirectory, { recursive: true }),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsManager = SettingsManager.create(workingDirectory, agentDirectory);
  const commandArguments = [];
  const fixtureCommand = (pi) => {
    pi.registerCommand("pippin_fixture", {
      description: "Verify SDK native command dispatch.",
      handler: async (args) => commandArguments.push(args),
    });
  };
  const fixtureNativeTool = (pi) =>
    pi.registerTool({
      name: "pippin_fixture_native",
      label: "Fixture native tool",
      description: "Verify active native tools survive a Pi resource reload.",
      parameters: Type.Object({}, { additionalProperties: false }),
      defaultActive: false,
      execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }),
    });
  const resourceLoader = createPiResourceLoader({
    workingDirectory,
    agentDirectory,
    settingsManager,
    mcpOptions: { loadConfig: () => ({ servers: [], errors: [] }) },
    additionalFactories: [fixtureCommand, fixtureNativeTool],
  });
  return { workingDirectory, agentDirectory, settingsManager, commandArguments, resourceLoader };
}

async function verifyNativeExtensionSpikeCase1Stage2(
  t,
  workingDirectory,
  agentDirectory,
  settingsManager,
  resourceLoader,
) {
  await resourceLoader.reload();
  settingsManager.applyOverrides({ defaultTools: ["+read", "+grep"] });
  enablePiNativeDefaultTools(settingsManager);
  const fixture = await createLocalFixtureModel(agentDirectory);
  const { session } = await createAgentSession({
    cwd: workingDirectory,
    agentDir: agentDirectory,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(workingDirectory),
    modelRuntime: fixture.modelRuntime,
    model: fixture.model,
  });
  const extensionUi = new ExtensionUiBridge(session);
  t.after(() => {
    extensionUi.close();
    session.dispose();
  });
  await bindPiExtensions(session, extensionUi.context);
  assert.ok(session.getActiveToolNames().includes("codemode"));
  assert.ok(session.getActiveToolNames().includes("tool_search"));
  assert.ok(session.getActiveToolNames().includes("read"));
  assert.ok(session.getActiveToolNames().includes("grep"));
  assert.ok(session.extensionRunner.getCommand("mcp"));
  assert.ok(session.extensionRunner.getCommand("pippin_fixture"));
  assert.equal(
    session.getActiveToolNames().some((name) => name.startsWith("mcp__")),
    false,
  );
  assert.equal(session.getActiveToolNames().includes("pippin_fixture_native"), false);
  session.setActiveToolsByName([...session.getActiveToolNames(), "pippin_fixture_native"]);
  assert.ok(session.getActiveToolNames().includes("pippin_fixture_native"));
  return { session };
}

async function verifyNativeExtensionSpikeCase1Stage3(commandArguments, session) {
  await reloadPiResources(session);
  assert.ok(session.getActiveToolNames().includes("codemode"));
  assert.ok(session.getActiveToolNames().includes("tool_search"));
  assert.ok(session.getActiveToolNames().includes("read"));
  assert.ok(session.getActiveToolNames().includes("grep"));
  assert.ok(session.extensionRunner.getCommand("mcp"));
  assert.ok(session.extensionRunner.getCommand("pippin_fixture"));
  assert.ok(session.getActiveToolNames().includes("pippin_fixture_native"));
  await session.prompt("/pippin_fixture preserve this exact argument");
  assert.deepEqual(commandArguments, ["preserve this exact argument"]);
  assert.equal(
    session.sessionManager.getBranch().some((entry) => entry.type === "message"),
    false,
  );
}

async function prepareNativeExtensionSpikeCase2Stage1(t) {
  const root = await mkdtemp(join(tmpdir(), "aeon-pi-attention-spike-"));
  const workingDirectory = join(root, "project");
  const agentDirectory = join(root, "pi-agent");
  const sessionDirectory = join(root, "sessions");
  await Promise.all([
    mkdir(workingDirectory, { recursive: true }),
    mkdir(agentDirectory, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsManager = SettingsManager.create(workingDirectory, agentDirectory);
  const dialogCommandCalls = [];
  const fixtureCommand = (pi) => {
    pi.registerCommand("request_confirmation", {
      description: "Exercise the exact-chat dialog lifecycle.",
      handler: async (_args, context) => {
        dialogCommandCalls.push("entered");
        await context.ui.confirm("Continue?", "This is a local fixture request.");
      },
    });
  };
  const resourceLoader = createPiResourceLoader({
    workingDirectory,
    agentDirectory,
    settingsManager,
    additionalFactories: [fixtureCommand],
  });
  await resourceLoader.reload();
  const fixture = await createLocalFixtureModel(agentDirectory);
  const chatId = randomUUID();
  const activationId = randomUUID();
  const manager = SessionManager.create(workingDirectory, sessionDirectory, { id: activationId });
  return {
    workingDirectory,
    agentDirectory,
    settingsManager,
    dialogCommandCalls,
    resourceLoader,
    fixture,
    chatId,
    activationId,
    manager,
  };
}

async function verifyNativeExtensionSpikeCase2Stage2(
  t,
  workingDirectory,
  agentDirectory,
  settingsManager,
  resourceLoader,
  fixture,
  chatId,
  activationId,
  manager,
) {
  const { session } = await createAgentSession({
    cwd: workingDirectory,
    agentDir: agentDirectory,
    settingsManager,
    resourceLoader,
    sessionManager: manager,
    modelRuntime: fixture.modelRuntime,
    model: fixture.model,
    tools: fixture.tools,
  });
  const extensionUi = new ExtensionUiBridge(session);
  await bindPiExtensions(session, extensionUi.context);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const handle = wrapPiSession(
    session,
    manager,
    { sessionId: activationId, sessionFile },
    chatId,
    extensionUi,
  );
  t.after(() => handle.close());
  const events = [];
  const unsubscribe = handle.subscribe((event) => events.push(event));
  t.after(unsubscribe);
  assert.ok(session.extensionRunner.getCommand("request_confirmation"));
  assert.deepEqual(handle.snapshot().contextUsage, expectedContextUsage(session.getContextUsage()));
  const pendingCommand = handle.submit("/request_confirmation");
  return { session, handle, events, pendingCommand };
}

async function verifyNativeExtensionSpikeCase2Stage3(
  dialogCommandCalls,
  session,
  handle,
  events,
  pendingCommand,
) {
  await Promise.race([
    waitFor(() => handle.extensionUiSnapshot().dialogs.length === 1).catch((error) => {
      throw new Error(
        `${error.message} commandCalls=${dialogCommandCalls.length}; ui=${JSON.stringify(handle.extensionUiSnapshot())}`,
      );
    }),
    pendingCommand.then(
      () => {
        throw new Error("The extension command completed before opening its confirmation dialog.");
      },
      (error) => {
        throw new Error(
          `The extension command rejected before opening its dialog: ${String(error)}`,
        );
      },
    ),
  ]);
  const [request] = handle.extensionUiSnapshot().dialogs;
  assert.ok(request);
  assert.equal(handle.snapshot().runState, "needs_attention");
  assert.ok(events.some(({ kind, state }) => kind === "run-state" && state === "needs_attention"));
  assert.equal(handle.answerExtensionUi(request.requestId, false), true);
  await pendingCommand;
  await handle.submit("Report context usage for this fixture turn.");
  await waitFor(
    () => events.some(({ kind }) => kind === "context-usage"),
    "a projected Pi context-usage event",
  );
  assert.equal(handle.snapshot().runState, "idle");
  assert.ok(events.some(({ kind, state }) => kind === "run-state" && state === "idle"));
  const contextEvent = events.findLast(({ kind }) => kind === "context-usage");
  assert.deepEqual(contextEvent.contextUsage, expectedContextUsage(session.getContextUsage()));
}
