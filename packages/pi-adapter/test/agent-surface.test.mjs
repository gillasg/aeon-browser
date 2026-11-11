import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { asActivationId, asChatId } from "@aeon/domain";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
} from "@earendil-works/pi-ai/utils/transcript";
import { AGENT_SURFACE_PAGE, buildAgentSurface, hashAgentSurface } from "../dist/agent-surface.js";
import { createChatTools } from "../dist/chat-tools.js";
import { captureFixtureModelRequest } from "../dist/fixture-model.js";
import { PiSdkSessionAdapter } from "../dist/index.js";

test(
  "the agent surface equals a new chat's first model request",
  { timeout: 120_000 },
  async (t) => {
    const paths = await sandbox(t);
    const surface = await buildAgentSurface(dirs(paths, "sessions-a"));
    const again = await buildAgentSurface(dirs(paths, "sessions-b"));
    const captured = await captureFirstRequest(dirs(paths, "sessions-c"));
    const identity = {
      systemPrompt: surface.systemPrompt,
      tools: surface.tools,
      firstTurn: surface.firstTurn,
    };
    assert.equal(again.hash, surface.hash);
    assert.equal(surface.hash, hashAgentSurface(identity));
    assert.notEqual(
      hashAgentSurface({ ...identity, firstTurn: identity.firstTurn + "x" }),
      surface.hash,
    );
    assert.match(surface.hash, /^[a-f0-9]{64}$/);
    assert.equal(surface.systemPrompt, getCurrentSystemPrompt(captured.messages));
    assert.deepEqual(surface.tools, declaredTools(captured.messages));
    assert.match(surface.firstTurn, /\[now\] Tue 10 Nov 2026 14:32 IST/);
    assert.match(surface.firstTurn, /\[page\] example\.test · Page title/);
    assert.match(surface.firstTurn, /\[saved\] none\n\[api\] none\n\[tabs\] none\n\nNew chat\.$/);
    const context = surface.firstTurn.slice(0, surface.firstTurn.length - "\n\nNew chat.".length);
    assert.ok(messageTexts(captured.messages).some((text) => text.includes(context)));
    assert.ok(messageTexts(captured.messages).some((text) => text.includes("New chat.")));
    assert.match(surface.systemPrompt, /browser_code/);
    const names = new Set(surface.tools.map((tool) => tool.name));
    for (const tool of createChatTools(toolInput(paths)))
      assert.ok(names.has(tool.name), tool.name);
    const browser = surface.tools.find((tool) => tool.name === "browser_code");
    assert.ok(browser);
    assert.equal(browser.parameters.type, "object");
    assert.ok(browser.description.length > 0);
  },
);

function dirs(paths, session) {
  return {
    workingDirectory: paths.workingDirectory,
    agentDirectory: paths.agentDirectory,
    sessionDirectory: join(paths.root, session),
  };
}

function toolInput(paths) {
  return {
    chatId: "00000000-0000-4000-8000-0000000000aa",
    workingDirectory: paths.workingDirectory,
    sessionDirectory: join(paths.root, "sessions-a"),
    completion: {
      sessionDirectory: join(paths.root, "sessions-a"),
      agentDirectory: paths.agentDirectory,
      preferredInitialModel: undefined,
    },
  };
}

async function captureFirstRequest(paths) {
  await mkdir(paths.sessionDirectory, { recursive: true });
  let first;
  const stop = captureFixtureModelRequest((context) => {
    first ??= context;
  });
  const previousNow = process.env.AEON_SURFACE_NOW;
  const previousZone = process.env.AEON_SURFACE_ZONE;
  process.env.AEON_SURFACE_NOW = "2026-11-10T09:02:00.000Z";
  process.env.AEON_SURFACE_ZONE = "Asia/Kolkata";
  const adapter = new PiSdkSessionAdapter({
    sessionDirectory: paths.sessionDirectory,
    agentDirectory: paths.agentDirectory,
    testModel: "local-faux",
    browserGuidance: true,
    fixtureToolAllowlist: false,
  });
  try {
    const session = await adapter.openOrCreate({
      chatId: asChatId(randomUUID()),
      activationId: asActivationId(randomUUID()),
      workingDirectory: paths.workingDirectory,
      reference: null,
      materialized: false,
    });
    await session.submit({ text: "New chat.", browserContext: AGENT_SURFACE_PAGE });
  } finally {
    stop();
    await adapter.closeAll();
    if (previousNow === undefined) delete process.env.AEON_SURFACE_NOW;
    else process.env.AEON_SURFACE_NOW = previousNow;
    if (previousZone === undefined) delete process.env.AEON_SURFACE_ZONE;
    else process.env.AEON_SURFACE_ZONE = previousZone;
  }
  assert.ok(first, "the fixture model received the first request");
  return first;
}

function messageTexts(messages) {
  return messages.flatMap((message) => {
    const text = blockText(message.content);
    return text ? [text] : [];
  });
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function declaredTools(messages) {
  return getCurrentTools(messages).map((tool) => {
    const declared = toToolDeclaration(tool);
    return {
      name: declared.name,
      description: declared.description,
      parameters: declared.parameters,
    };
  });
}

async function sandbox(t) {
  const root = resolve(await mkdtemp(join(tmpdir(), "aeon-agent-surface-")));
  assert.ok(root.startsWith(`${resolve(tmpdir())}${sep}`));
  const paths = {
    root,
    workingDirectory: join(root, "workspace"),
    agentDirectory: join(root, "agent"),
  };
  await Promise.all([
    mkdir(paths.workingDirectory, { recursive: true }),
    mkdir(paths.agentDirectory, { recursive: true }),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return paths;
}
