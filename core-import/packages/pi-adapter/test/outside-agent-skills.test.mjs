import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPiResourceLoader, withoutOutsideAgentSkills } from "../dist/sdk-resources.js";

async function skill(root, name) {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`,
  );
}

test("Aeon's own agent never sees the skill written for agents outside Aeon", async () => {
  assert.deepEqual(
    withoutOutsideAgentSkills([{ name: "aeon" }, { name: "pdf" }]).map((item) => item.name),
    ["pdf"],
  );
  const root = await mkdtemp(join(tmpdir(), "aeon-outside-skills-"));
  const agent = join(root, "agent"),
    cwd = join(root, "work");
  try {
    await skill(join(agent, "skills"), "aeon");
    await skill(join(agent, "skills"), "notes");
    await mkdir(cwd, { recursive: true });
    const loader = createPiResourceLoader({
      workingDirectory: cwd,
      agentDirectory: agent,
      settingsManager: SettingsManager.create(cwd, agent),
    });
    await loader.reload();
    const names = loader.getSkills().skills.map((item) => item.name);
    assert.ok(names.includes("notes"), `other skills still load (got ${names.join(", ")})`);
    assert.ok(!names.includes("aeon"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
