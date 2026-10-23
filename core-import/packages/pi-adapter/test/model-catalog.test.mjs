import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiSdkSessionAdapter } from "../dist/index.js";

test("model catalog is sourced from Pi and reports model-specific effort support", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aeon-model-catalog-"));
  const agentDirectory = join(directory, "agent");
  await mkdir(agentDirectory, { recursive: true });
  const adapter = new PiSdkSessionAdapter({
    sessionDirectory: join(directory, "sessions"),
    agentDirectory,
    testModel: "local-faux",
  });
  try {
    const catalog = await adapter.getModelCatalog();
    assert.equal(catalog.defaultModel?.provider, "aeon-local-fixture");
    assert.equal(catalog.defaultModel?.id, "read-only-stream");
    assert.deepEqual(catalog.models[0]?.thinkingLevels, ["off"]);
    assert.equal(catalog.models[0]?.defaultThinkingLevel, "off");
  } finally {
    await adapter.closeAll();
    await rm(directory, { recursive: true, force: true });
  }
});
