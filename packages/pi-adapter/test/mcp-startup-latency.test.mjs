import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPiResourceLoader, bindPiExtensions } from "../dist/sdk-resources.js";
import { createLocalFixtureModel } from "../dist/fixture-model.js";
import { ExtensionUiBridge } from "../dist/extension-ui-bridge.js";
import { performance } from "node:perf_hooks";
test("a connecting MCP server does not impose a ten-second wait on a local first prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "aeon-mcp-startup-"));
  const agentDir = join(root, "agent"),
    server = join(root, "waiting.mjs");
  await mkdir(agentDir);
  const pidFile = join(root, "server.pid");
  await writeFile(
    server,
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
  );
  let session, bridge;
  try {
    const settingsManager = SettingsManager.create(root, agentDir);
    const resourceLoader = createPiResourceLoader({
      workingDirectory: root,
      agentDirectory: agentDir,
      settingsManager,
      mcpOptions: {
        loadConfig: () => ({
          servers: [
            {
              name: "waiting",
              source: "fixture",
              config: {
                type: "stdio",
                command: process.execPath,
                args: [server],
                enabled: true,
                exposure: "codemode",
              },
            },
          ],
          errors: [],
        }),
      },
    });
    await resourceLoader.reload();
    const fixture = await createLocalFixtureModel(agentDir);
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.create(root, join(root, "sessions")),
      modelRuntime: fixture.modelRuntime,
      model: fixture.model,
    }));
    bridge = new ExtensionUiBridge(session);
    await bindPiExtensions(session, bridge.context);
    session.setActiveToolsByName(fixture.tools);
    const start = performance.now();
    await session.prompt("hello");
    assert.ok(performance.now() - start < 3000, "Optional MCP startup blocked the first prompt");
  } finally {
    await closeFixture(session, bridge, root, pidFile);
  }
});
async function closeFixture(session, bridge, root, pidFile) {
  bridge?.close();
  const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
  if (pid > 0) {
    try {
      process.kill(pid);
    } catch {
      /* Already stopped. */
    }
  }
  await session?.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
  session?.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
