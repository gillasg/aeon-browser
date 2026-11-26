// The per-site `SKILL.md`, as callers see it: read it, let the user write their own section,
// let an agent add facts (filtered), and the short brief loaded when a run visits or calls the
// host. The brief lists facts, helpers and compiled ops; it never loads helper code.

import { readFile } from "node:fs/promises";
import { siteName } from "./registry.js";
import { readSiteFacts, renderSiteNotes, writeSiteNotes } from "./site-notes.js";
import { readOpsFile } from "./site-ops-file.js";
import { opLine, readSkillFile, skillPath, writeSkillFile } from "./site-skill-file.js";

export { SKILL_FILE, skillPath } from "./site-skill-file.js";

const BRIEF_MAX = 2400;

/** The whole file, migrating old notes first. Empty when the site has nothing yet. */
export async function readSiteSkill(site: string): Promise<string> {
  await readSiteFacts(site);
  return readFile(skillPath(site), "utf8").catch(() => "");
}

/** The user's own text. Not filtered: the user may write anything about their own sites. */
export async function writeSiteSkillUser(site: string, text: string): Promise<string> {
  await readSiteFacts(site);
  return writeSkillFile(site, { user: text });
}

/** An agent's markdown: only facts that pass the instruction and same-origin checks are kept. */
export async function agentWriteSiteSkill(site: string, markdown: string): Promise<string> {
  return writeSiteNotes(site, markdown, { append: true });
}

/** What a run on this host is told, concisely. Empty when nothing is known. */
export async function siteSkillBrief(site: string, max = BRIEF_MAX): Promise<string> {
  const host = siteName(site);
  const [facts, doc, ops] = await Promise.all([
    readSiteFacts(host),
    readSkillFile(host),
    readOpsFile(host),
  ]);
  const helpers = (ops?.ops ?? []).filter((op) => op.source === "helper" && op.enabled !== false);
  const compiled = (ops?.ops ?? []).filter((op) => op.source !== "helper");
  const parts = [
    doc?.user ? doc.user : "",
    renderSiteNotes(facts),
    helpers.length
      ? `helpers: ${helpers.map((op) => op.id).join(", ")} (load with siteSkill get)`
      : "",
    compiled.length ? compiled.slice(0, 20).map(opLine).join("\n") : "",
  ].filter(Boolean);
  const brief = parts.join("\n");
  return brief.length > max ? `${brief.slice(0, max - 3)}...` : brief;
}
