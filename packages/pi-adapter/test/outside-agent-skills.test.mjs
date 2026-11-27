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

test("Graft's own agent never sees outside-agent or personal Pi skills and extensions", async () => {
  assert.deepEqual(
    withoutOutsideAgentSkills([{ name: "graft" }, { name: "pdf" }]).map((item) => item.name),
    ["pdf"],
  );
  const root = await mkdtemp(join(tmpdir(), "graft-outside-skills-"));
  const agent = join(root, "agent"),
    cwd = join(root, "work");
  try {
    await skill(join(agent, "skills"), "graft");
    await skill(join(agent, "skills"), "notes");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(agent, "extensions"), { recursive: true });
    await writeFile(
      join(agent, "extensions", "personal.ts"),
      'export default (pi) => pi.registerTool({ name: "personal_tool" });\n',
    );
    // Graft owns its tool surface: the user's own Pi skills and extensions never load.
    const loader = createPiResourceLoader({
      workingDirectory: cwd,
      agentDirectory: agent,
      settingsManager: SettingsManager.create(cwd, agent),
    });
    await loader.reload();
    assert.deepEqual(loader.getSkills().skills, []);
    const paths = loader.getExtensions().extensions.map((item) => item.path);
    assert.ok(!paths.some((path) => path.includes("personal.ts")), paths.join(", "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
