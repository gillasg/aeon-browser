// The real Pi agent loop must execute the call a leaked DSML text block is turned into, and the
// leaked markup must never reach the chat's answer. A unit test of the parser is not enough: Pi
// reads tool calls off the same assistant message a message_end handler replaces in place.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { leakedToolCallGuard } from "../dist/leaked-tool-call-guard.js";

test("a leaked DSML tool call runs as a real tool call through Pi", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aeon-leak-guard-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const settings = SettingsManager.create(cwd, agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const leaked = `<｜DSML｜ calls>
<｜DSML｜ invoke name="browser_code">
<｜DSML｜ parameter name="code" string="true">return 'ok';</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>`;
  const fixture = fauxProvider({
    provider: "fixture",
    api: "fixture-api",
    models: [
      {
        id: "m",
        name: "m",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8000,
        maxTokens: 256,
      },
    ],
    tokensPerSecond: 1000,
    tokenSize: { min: 2, max: 6 },
  });
  fixture.setResponses([
    () => fauxAssistantMessage(leaked, { stopReason: "stop" }),
    () => fauxAssistantMessage("The answer is fine.", { stopReason: "stop" }),
  ]);
  modelRuntime.registerNativeProvider(fixture.provider);
  const model = fixture.getModel("m");

  let executed = 0;
  const tool = defineTool({
    name: "browser_code",
    label: "browser code",
    description: "run code",
    parameters: Type.Object({ code: Type.String() }),
    execute: async () => {
      executed += 1;
      return { content: [{ type: "text", text: "ran" }], details: {} };
    },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    extensionFactories: [leakedToolCallGuard(), (pi) => pi.registerTool(tool)],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    modelRuntime,
    model,
  });
  t.after(() => session.dispose());
  await session.prompt("go");
  await session.waitForIdle();

  assert.equal(executed, 1, "the leaked call was executed as a tool");
  const texts = session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message)
    .filter((message) => message?.role === "assistant")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => block.text);
  assert.ok(!texts.some((text) => text.includes("DSML")), "markup never appears in the answer");
  assert.ok(texts.includes("The answer is fine."));
});
