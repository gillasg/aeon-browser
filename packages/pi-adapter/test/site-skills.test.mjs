import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  enableSiteSkills,
  importSiteSkills,
  readSiteSkills,
  siteSkillCall,
} from "../dist/browser-site-skills.js";

// Skills live in the unified site memory; each test gets its own home.
const previousHome = process.env.SITE_TO_API_HOME;
let home;
test.beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "graft-skills-home-"));
  process.env.SITE_TO_API_HOME = home;
});
test.afterEach(async () => {
  if (previousHome === undefined) delete process.env.SITE_TO_API_HOME;
  else process.env.SITE_TO_API_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

test("imported skills are enabled", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "graft-skills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imported = await importSiteSkills(directory, [
    { name: "search", domains: ["shop.example"], description: "Search", code: "const x = 1;" },
    { name: "other", domains: ["other.example"], code: "const y = 2;" },
  ]);
  assert.deepEqual(
    imported.map((skill) => [skill.name, skill.enabled]),
    [
      ["search", true],
      ["other", true],
    ],
  );
  assert.deepEqual(
    (await siteSkillCall(directory, { siteSkill: "list" })).map((skill) => skill.name).sort(),
    ["other", "search"],
  );
  assert.equal(
    (await siteSkillCall(directory, { siteSkill: "get", name: "search" })).name,
    "search",
  );
  assert.equal((await readSiteSkills(directory)).length, 2);

  assert.deepEqual(await enableSiteSkills(directory, "shop.example"), []);
  assert.deepEqual(
    (await siteSkillCall(directory, { siteSkill: "list", url: "https://shop.example/x" })).map(
      (skill) => skill.name,
    ),
    ["search"],
  );
  assert.equal(
    (await siteSkillCall(directory, { siteSkill: "get", name: "search" })).name,
    "search",
  );
});

test("loopback site skills isolate by host:port", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "graft-skills-loopback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await importSiteSkills(directory, [
    { name: "app-a", domains: ["127.0.0.1:4100"], description: "App A", code: "const a = 1;" },
    { name: "app-b", domains: ["127.0.0.1:4200"], description: "App B", code: "const b = 2;" },
  ]);
  const aSkills = await siteSkillCall(directory, {
    siteSkill: "list",
    url: "http://127.0.0.1:4100/dashboard",
  });
  const bSkills = await siteSkillCall(directory, {
    siteSkill: "list",
    url: "http://127.0.0.1:4200/dashboard",
  });
  assert.deepEqual(
    aSkills.map((skill) => skill.name),
    ["app-a"],
  );
  assert.deepEqual(
    bSkills.map((skill) => skill.name),
    ["app-b"],
  );
});
