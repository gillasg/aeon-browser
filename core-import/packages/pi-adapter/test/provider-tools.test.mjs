import test from "node:test";
import assert from "node:assert/strict";
import { installBrowserControlRequestProjection } from "../dist/browser-provider-projection.js";
test("Codex provider request includes all active Pi tools without duplicates", async () => {
  const runner = { hasHandlers: () => false, emitBeforeProviderRequest: async () => undefined };
  const session = {
    extensionRunner: runner,
    model: { provider: "openai-codex", api: "openai-codex-responses" },
    getActiveToolNames: () => ["read", "write", "bash", "codemode", "browser_control"],
    getToolDefinition: () => ({
      description: "tool",
      parameters: { type: "object", properties: {} },
    }),
  };
  installBrowserControlRequestProjection(session);
  const result = await runner.emitBeforeProviderRequest({
    tools: [{ type: "function", name: "browser_control" }],
  });
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["browser_control", "read", "write", "bash", "codemode"],
  );
});
