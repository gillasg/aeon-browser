import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  exportSitePack,
  installSitePack,
  readSitePack,
  skillsForSite,
  type PackBoost,
} from "@browserkit/site-mapper";
import { flag, has, type Args } from "browserkit/dist/args.js";
import { printJson } from "browserkit/dist/output.js";
import { dataDirectory } from "./client.js";
import type { DaemonHost } from "./host.js";

// Site packs for Aeon: a mapped site plus the site skills and boosts written for it. Export strips
// sessions, cookies and credential-bearing bodies/headers. Import writes the site, saves skills and
// boosts DISABLED, and prints their code; the user enables them explicitly.

interface Skill {
  name: string;
  domains: string[];
  description?: string;
  examples?: string;
  code: string;
  enabled?: boolean;
  updatedAt?: number;
}

const skils = () => join(dataDirectory(), "site-skills");

async function siteSkills(site: string): Promise<Skill[]> {
  return skillsForSite(await readSkills(), site);
}

async function readSkills(): Promise<Skill[]> {
  const files = (await readdir(skils()).catch(() => [] as string[])).filter((file) =>
    file.endsWith(".json"),
  );
  const skills = await Promise.all(
    files.map((file) =>
      readFile(join(skils(), file), "utf8").then(
        (text) => JSON.parse(text) as Skill,
        () => undefined,
      ),
    ),
  );
  return skills.filter((skill): skill is Skill => !!skill?.name);
}

async function importSkills(skills: Skill[]): Promise<Skill[]> {
  const saved: Skill[] = [];
  for (const skill of skills) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.name)) continue;
    const valid: Skill = {
      ...skill,
      domains: (skill.domains ?? []).map((domain) => String(domain).toLowerCase()),
      enabled: false,
      updatedAt: Date.now(),
    };
    await writeSkill(valid);
    saved.push(valid);
  }
  return saved;
}

async function enableSkills(site: string): Promise<string[]> {
  const host = site.replace(/^https?:\/\//, "").split("/")[0] ?? site;
  const enabled: string[] = [];
  for (const skill of await readSkills()) {
    if (skill.enabled !== false || !skill.domains.some((domain) => matches(host, domain))) continue;
    await writeSkill({ ...skill, enabled: true, updatedAt: Date.now() });
    enabled.push(skill.name);
  }
  return enabled;
}

async function writeSkill(skill: Skill): Promise<void> {
  await mkdir(skils(), { recursive: true });
  await writeFile(join(skils(), skill.name + ".json"), JSON.stringify(skill, null, 2) + "\n");
}

function matches(host: string, domain: string): boolean {
  if (domain.startsWith("*.")) return host === domain.slice(2) || host.endsWith(domain.slice(1));
  return host === domain || host.endsWith("." + domain);
}

async function runInBrowser(host: DaemonHost, code: string): Promise<unknown> {
  return host.runInBrowser(code, { session: "cli" });
}

async function siteBoosts(host: DaemonHost, site: string): Promise<PackBoost[]> {
  return (await runInBrowser(
    host,
    `(async () => { const listed = await browser.boosts.list(${JSON.stringify(`https://${site}`)}); const full = []; for (const item of listed) { const boost = await browser.boosts.get(item.id); if (boost) full.push(boost); } return full; })()`,
  )) as PackBoost[];
}

async function exportPack(host: DaemonHost, args: Args): Promise<number> {
  const site = args.positional[1];
  if (!site) throw new Error("Usage: aeon pack export <site> --out <file.zip>");
  const out = (flag(args, "out") ?? `${site}.zip`) as string;
  let boosts: PackBoost[] = [];
  let warning: string | undefined;
  if (!has(args, "no-boosts")) {
    try {
      boosts = await siteBoosts(host, site);
    } catch (error) {
      warning = `Boosts left out: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const packed = await exportSitePack({ site, out, skills: await siteSkills(site), boosts });
  if (has(args, "json")) {
    printJson({ ...packed, ...(warning ? { warning } : {}) });
    return 0;
  }
  process.stdout.write(
    `Exported ${packed.site} to ${packed.out}: ${packed.files.length} site files, ${packed.skills.length} skills, ${packed.boosts.length} boosts.\n` +
      "Sessions, cookies and credential-bearing headers and bodies are stripped.\n",
  );
  if (warning) process.stderr.write(warning + "\n");
  return 0;
}

async function importPack(host: DaemonHost, args: Args): Promise<number> {
  const file = args.positional[1];
  if (!file) throw new Error("Usage: aeon pack import <file.zip>");
  const pack = await readSitePack(file);
  const installed = await installSitePack(pack);
  const skills = await importSkills(pack.skills);
  const { boosts, warning } = await saveImportedBoosts(host, pack.boosts);
  if (has(args, "json")) {
    printJson({
      site: installed.site,
      files: installed.written,
      skills: skills.map((skill) => ({ name: skill.name, enabled: false, code: skill.code })),
      boosts,
      ...(warning ? { warning } : {}),
    });
    return 0;
  }
  process.stdout.write(
    `Imported ${installed.site}: ${installed.written.length} site files. Skills and boosts are DISABLED.\n`,
  );
  printImportedCode(skills, pack.boosts);
  process.stdout.write(
    `\nReview the code above, then enable with: aeon pack enable ${installed.site}\n`,
  );
  if (warning) process.stderr.write(warning + "\n");
  return 0;
}

async function saveImportedBoosts(
  host: DaemonHost,
  boosts: PackBoost[],
): Promise<{ boosts: { id?: string; name: string }[]; warning?: string }> {
  if (!boosts.length) return { boosts: [] };
  try {
    const saved = (await runInBrowser(
      host,
      `(async () => { const saved = []; for (const boost of ${JSON.stringify(boosts)}) { const result = await browser.boosts.save({ ...boost, enabled: false }); const id = result?.id ?? boost.id; if (id) await browser.boosts.enable(id, false); saved.push({ id, name: boost.name }); } return saved; })()`,
    )) as { id?: string; name: string }[];
    return { boosts: saved };
  } catch (error) {
    return {
      boosts: [],
      warning: `Boosts not saved (open Aeon and import again): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function printImportedCode(
  skills: { name: string; domains: string[]; code: string }[],
  boosts: PackBoost[],
): void {
  for (const skill of skills)
    process.stdout.write(
      `\n--- skill ${skill.name} (${skill.domains.join(", ")}) ---\n${skill.code}\n`,
    );
  for (const boost of boosts) {
    const code = typeof boost.js === "string" ? boost.js : "";
    process.stdout.write(`\n--- boost ${boost.name}${code ? " (js)" : ""} ---\n`);
    if (code) process.stdout.write(code + "\n");
  }
}

async function enablePack(host: DaemonHost, args: Args): Promise<number> {
  const site = args.positional[1];
  if (!site) throw new Error("Usage: aeon pack enable <site>");
  const skills = await enableSkills(site);
  let boosts: { id?: string; name?: string }[] = [];
  let warning: string | undefined;
  try {
    boosts = (await runInBrowser(
      host,
      `(async () => { const listed = await browser.boosts.list(${JSON.stringify(`https://${site}`)}); for (const boost of listed) await browser.boosts.enable(boost.id, true); return listed; })()`,
    )) as { id?: string; name?: string }[];
  } catch (error) {
    warning = `Boosts not enabled: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (has(args, "json")) printJson({ site, skills, boosts, ...(warning ? { warning } : {}) });
  else {
    process.stdout.write(
      `Enabled ${skills.length} skills and ${boosts.length} boosts for ${site}.\n`,
    );
    for (const name of skills) process.stdout.write(`  skill ${name}\n`);
    for (const boost of boosts) process.stdout.write(`  boost ${String(boost.name ?? boost.id)}\n`);
    if (warning) process.stderr.write(warning + "\n");
  }
  return 0;
}

export async function packCommand(host: DaemonHost, args: Args): Promise<number> {
  const action = args.positional[0] ?? "export";
  if (action === "export") return exportPack(host, args);
  if (action === "import") return importPack(host, args);
  if (action === "enable") return enablePack(host, args);
  throw new Error(
    "Usage: aeon pack export <site> --out file.zip | import <file.zip> | enable <site>",
  );
}
