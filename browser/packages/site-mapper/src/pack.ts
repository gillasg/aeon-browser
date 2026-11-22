import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Ability } from "./abilities.js";
import { abilitySlug } from "./ability-files.js";
import {
  formatFinding,
  lintPublicAbility,
  publicAbility,
  type PublishFinding,
} from "./ability-publish.js";
import { createRedactor, SECRET_HEADERS, SECRET_KEYS } from "./redact.js";
import { scrubAbility } from "./ability-scrub.js";
import { siteDir, siteName } from "./registry.js";
import { importPackAbilities } from "./abilities-migrate.js";

// A site pack is a zip of everything needed to use a mapped site on another machine: the model,
// spec and client, the recorded flows, and the browser skills and boosts written for it. Export
// strips sessions, cookies and credential-bearing headers/bodies; import writes the site files but
// hands the skills and boosts back to the caller to save disabled, because their code runs in the
// user's browser.

export const PACK_FORMAT = "browserkit-site-pack";
export const PACK_VERSION = 1;
const TOP_FILES = [
  "model.json",
  "openapi.json",
  "openapi.yaml",
  "client.ts",
  "overrides.json",
  "actions.json",
  "recipes.json",
  "tools.json",
  "agents.json",
  "health.json",
  "docs.md",
  "notes.md",
  "notes.json",
];
const SKIP = /^(sessions?|cookies?|storage|auth|credentials?|versions?|\.git)$/i;

export interface PackSkill {
  name: string;
  domains: string[];
  description?: string;
  examples?: string;
  code: string;
  enabled?: boolean;
  updatedAt?: number;
}

export interface PackBoost {
  id?: string;
  name: string;
  sites?: unknown[];
  css?: string;
  zaps?: unknown[];
  actions?: unknown[];
  network?: unknown;
  js?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface PackManifest {
  format: typeof PACK_FORMAT;
  version: typeof PACK_VERSION;
  site: string;
  exportedAt: string;
  files: string[];
  skills: string[];
  boosts: string[];
}

export interface PackExport {
  site: string;
  out: string;
  files: string[];
  skills: string[];
  boosts: string[];
  /** Public ability definitions written into the pack. */
  published: number;
  /** Deterministic publish checks, including notices that did not block. */
  findings: (PublishFinding & { ability: string })[];
}

export interface SitePack {
  manifest: PackManifest;
  /** Site files only, by pack-relative path. Skills and boosts are separate. */
  files: Map<string, string>;
  skills: PackSkill[];
  boosts: PackBoost[];
}

export async function exportSitePack(options: {
  site: string;
  out: string;
  skills?: PackSkill[];
  boosts?: PackBoost[];
  /** `block` (default) refuses a pack whose ability lint has errors; `warn` writes it anyway. */
  publish?: "block" | "warn";
}): Promise<PackExport> {
  const site = siteName(options.site);
  const root = siteDir(site);
  if (!existsSync(join(root, "model.json")))
    throw new Error(`No mapped site ${site}. Map it first (browserkit map).`);
  const redactor = createRedactor();
  const files: Record<string, Uint8Array> = {};
  const written: string[] = [];
  const add = (path: string, text: string) => {
    files[path] = strToU8(text);
    written.push(path);
  };
  for (const name of TOP_FILES) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    add(name, scrubFile(name, await readFile(path, "utf8"), redactor));
  }
  for (const name of await flowFiles(join(root, "flows"))) {
    const path = join(root, "flows", name);
    add(`flows/${name}`, scrubFile(name, await readFile(path, "utf8"), redactor));
  }
  // The site's abilities travel with it (the migration bookkeeping does not), each with the
  // public definition a stranger can review before calling it. The installer needs the runnable
  // file, so it ships scrubbed: a lint finding on it is either redacted before the write or stops
  // the pack (see shareAbility).
  const abilities = await readAbilityFiles(join(root, "abilities"));
  const shared = abilities.map((entry) => shareAbility(entry, redactor));
  for (const entry of shared) add(`abilities/${entry.file}`, entry.text);
  const published = publishAbilities(shared, add, redactor, options.publish ?? "block");
  const skills = (options.skills ?? []).map(sanitizeSkill);
  for (const skill of skills)
    add(`skills/${skill.name}.json`, JSON.stringify(skill, null, 2) + "\n");
  const boosts = (options.boosts ?? []).map(sanitizeBoost);
  boosts.forEach((boost, index) =>
    add(
      `boosts/${slug(boost.name || boost.id || `boost-${index + 1}`)}.json`,
      JSON.stringify(boost, null, 2) + "\n",
    ),
  );
  const manifest: PackManifest = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    site,
    exportedAt: new Date().toISOString(),
    files: written.filter((path) => !path.startsWith("skills/") && !path.startsWith("boosts/")),
    skills: skills.map((skill) => skill.name),
    boosts: boosts.map((boost) => String(boost.name ?? boost.id ?? "")),
  };
  add("pack.json", JSON.stringify(manifest, null, 2) + "\n");
  await mkdir(dirname(resolve(options.out)), { recursive: true });
  await writeFile(resolve(options.out), Buffer.from(zipSync(files, { level: 6 })));
  return {
    site,
    out: resolve(options.out),
    files: manifest.files,
    skills: manifest.skills,
    boosts: manifest.boosts,
    ...published,
  };
}

/** Reads a pack zip, or the folder a pack zip was extracted into. */
export async function readSitePack(file: string): Promise<SitePack> {
  const entries = (await isFolder(file)) ? await readFolder(file) : await readZip(file);
  const paths = Object.keys(entries);
  for (const path of paths) safePath(path);
  const manifest = readManifest(entries);
  return {
    manifest,
    files: siteFiles(entries, paths),
    skills: jsonEntries<PackSkill>(entries, paths, /^skills\/[^/]+\.json$/, (item) => {
      return typeof item.name === "string" && typeof item.code === "string";
    }),
    boosts: jsonEntries<PackBoost>(entries, paths, /^boosts\/[^/]+\.json$/, (item) => {
      return typeof item.name === "string";
    }),
  };
}

async function isFolder(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

async function readFolder(root: string): Promise<Record<string, Uint8Array>> {
  const entries: Record<string, Uint8Array> = {};
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!item.isFile()) continue;
    const full = join(item.parentPath, item.name);
    entries[relative(root, full).split(sep).join("/")] = new Uint8Array(await readFile(full));
  }
  return entries;
}

/** True when path is a site pack (a zip or extracted folder holding a pack.json). */
export async function isSitePack(path: string): Promise<boolean> {
  if (await isFolder(path)) return existsSync(join(path, "pack.json"));
  try {
    return Boolean(unzipSync(new Uint8Array(await readFile(path)))["pack.json"]);
  } catch {
    return false;
  }
}

async function readZip(file: string): Promise<Record<string, Uint8Array>> {
  try {
    return unzipSync(new Uint8Array(await readFile(file)));
  } catch {
    throw new Error(`${file} is not a zip file.`);
  }
}

function readManifest(entries: Record<string, Uint8Array>): PackManifest {
  const manifestText = text(entries["pack.json"]);
  if (!manifestText) throw new Error("The pack has no pack.json.");
  const manifest = JSON.parse(manifestText) as PackManifest;
  if (manifest.format !== PACK_FORMAT || manifest.version !== PACK_VERSION)
    throw new Error(`Unsupported pack format ${String(manifest.format)}.`);
  const site = siteName(String(manifest.site ?? ""));
  if (!/^[a-z0-9.-]+$/.test(site)) throw new Error("The pack has no valid site name.");
  return { ...manifest, site };
}

function siteFiles(entries: Record<string, Uint8Array>, paths: string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of paths) {
    if (path === "pack.json" || path.startsWith("skills/") || path.startsWith("boosts/")) continue;
    files.set(path, text(entries[path]) ?? "");
  }
  return files;
}

function jsonEntries<T>(
  entries: Record<string, Uint8Array>,
  paths: string[],
  pattern: RegExp,
  valid: (item: T) => boolean,
): T[] {
  return paths
    .filter((name) => pattern.test(name))
    .map((path) => JSON.parse(text(entries[path]) ?? "{}") as T)
    .filter(valid);
}

/** Writes the site files; the caller saves skills and boosts disabled. */
export async function installSitePack(
  pack: SitePack,
  site = pack.manifest.site,
): Promise<{ site: string; written: string[] }> {
  const name = siteName(site);
  const target = siteDir(name);
  const written: string[] = [];
  for (const [path, content] of pack.files) {
    const relative = safePath(path);
    const installed = relative.toLowerCase() === "tools.json" ? enabledTools(content) : content;
    const full = resolve(target, relative);
    if (!full.startsWith(resolve(target) + (process.platform === "win32" ? "\\" : "/")))
      throw new Error(`The pack contains an unsafe path: ${path}`);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, installed);
    written.push(relative);
  }
  await importPackAbilities(name, pack.skills ?? []);
  return { site: name, written };
}

/** Everything a pack brings is enabled, including code written for another machine. */
function enabledTools(content: string): string {
  try {
    const file = JSON.parse(content) as { tools?: unknown; pageTools?: unknown };
    for (const list of [file.tools, file.pageTools])
      if (Array.isArray(list))
        for (const tool of list) if (tool && typeof tool === "object") tool.enabled = true;
    return JSON.stringify(file, null, 2) + "\n";
  } catch {
    return content;
  }
}

/** Skills whose domains cover the site. */
export function skillsForSite(skills: PackSkill[], site: string): PackSkill[] {
  const host = siteName(site);
  return skills.filter((skill) =>
    (skill.domains ?? []).some((domain) => {
      const clean = String(domain).toLowerCase();
      return clean.startsWith("*.")
        ? host === clean.slice(2) || host.endsWith(clean.slice(1))
        : host === clean || host.endsWith("." + clean);
    }),
  );
}

function scrubFile(
  name: string,
  text: string,
  redactor: ReturnType<typeof createRedactor>,
): string {
  if (/\.(json|har)$/i.test(name)) {
    try {
      const value = JSON.parse(text) as unknown;
      return JSON.stringify(scrubValue(value, redactor), null, 2) + "\n";
    } catch {
      return scrubText(text, redactor);
    }
  }
  return scrubText(text, redactor);
}

function scrubValue(value: unknown, redactor: ReturnType<typeof createRedactor>): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, redactor));
  if (value && typeof value === "object")
    return scrubObject(value as Record<string, unknown>, redactor);
  return typeof value === "string" ? redactor.text(redactor.body(value) ?? value) : value;
}

function scrubObject(
  value: Record<string, unknown>,
  redactor: ReturnType<typeof createRedactor>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scrubField(key, item, redactor)]),
  );
}

function scrubField(
  key: string,
  item: unknown,
  redactor: ReturnType<typeof createRedactor>,
): unknown {
  if (/^cookies?$/i.test(key)) return [];
  if (/^(local|session)storage$/i.test(key)) return {};
  if (/^headers?$/i.test(key)) return scrubHeaders(item, redactor);
  if (SECRET_KEYS.test(key) && (item === null || typeof item !== "object")) return "<redacted>";
  return scrubValue(item, redactor);
}

function scrubHeaders(value: unknown, redactor: ReturnType<typeof createRedactor>): unknown {
  if (Array.isArray(value))
    return value.map((header) => {
      if (!header || typeof header !== "object") return header;
      const item = header as { name?: unknown; value?: unknown };
      return {
        ...item,
        value:
          typeof item.name === "string"
            ? redactor.header(item.name, String(item.value ?? ""))
            : "<redacted>",
      };
    });
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        SECRET_HEADERS.test(name) ? "<redacted>" : redactor.text(String(item)),
      ]),
    );
  return value;
}

function scrubText(text: string, redactor: ReturnType<typeof createRedactor>): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = /^(\s*)([A-Za-z][\w-]*):\s*(.+)$/.exec(line);
      if (match && match[2] && SECRET_HEADERS.test(match[2]))
        return `${match[1] ?? ""}${match[2]}: <redacted>`;
      return redactLiterals(redactor.text(line));
    })
    .join("\n");
}

/** `const token = "..."`, `password: "..."`, `authorization: '...'` in code or examples. */
const SECRET_LITERAL =
  /(\b(?:token|secret|password|passwd|api[_-]?key|session(?:id)?|authorization)\b\s*[:=]\s*)(['"`])([^'"`\n]+)\2/gi;

function redactLiterals(text: string): string {
  return text
    .replace(SECRET_LITERAL, "$1$2<redacted>$2")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>")
    .replace(/\b(sk|ghp|gho|ghu|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}/g, "<redacted>");
}

function sanitizeSkill(skill: PackSkill): PackSkill {
  const redactor = createRedactor();
  return {
    name: String(skill.name),
    domains: (skill.domains ?? []).map((domain) => String(domain)),
    description: redactor.text(String(skill.description ?? "")),
    examples: redactLiterals(redactor.text(String(skill.examples ?? ""))),
    code: redactLiterals(redactor.text(String(skill.code ?? ""))),
    enabled: true,
    updatedAt: Number(skill.updatedAt ?? Date.now()),
  };
}

function sanitizeBoost(boost: PackBoost): PackBoost {
  const redactor = createRedactor();
  const copy: PackBoost = { ...boost, enabled: false };
  delete copy.values;
  delete copy.settings;
  delete copy.health;
  delete copy.history;
  if (typeof copy.js === "string") copy.js = redactLiterals(redactor.text(copy.js));
  if (typeof copy.css === "string") copy.css = redactor.text(copy.css);
  return copy;
}

async function abilityFiles(folder: string): Promise<string[]> {
  if (!existsSync(folder)) return [];
  const names = await readdir(folder);
  return names.filter((name) => name.endsWith(".json") && !/^migration/.test(name)).sort();
}

async function readAbilityFiles(folder: string): Promise<{ file: string; text: string }[]> {
  const names = await abilityFiles(folder);
  return Promise.all(
    names.map(async (file) => ({ file, text: await readFile(join(folder, file), "utf8") })),
  );
}

interface SharedAbility {
  file: string;
  text: string;
  /** The runnable ability the pack writes, after scrubbing; absent when the file is not one. */
  ability?: Ability;
  /** What the lint said about the original, reported to the caller either way. */
  findings: (PublishFinding & { ability: string })[];
}

/**
 * The runnable ability a pack ships. It keeps its ways (the installer runs it) but is scrubbed
 * like a save; a lint finding that cannot be redacted is refused, because the private copy
 * travels beside the public definition. Notices about recorded values are removed here.
 */
function shareAbility(
  entry: { file: string; text: string },
  redactor: ReturnType<typeof createRedactor>,
): SharedAbility {
  const ability = parseAbility(entry.text);
  if (!ability)
    return { file: entry.file, text: scrubFile(entry.file, entry.text, redactor), findings: [] };
  const findings = lintPublicAbility(ability).map((finding) => ({
    ...finding,
    ability: ability.name,
  }));
  const scrub = scrubAbility(ability, redactor);
  if (scrub.refused) throw new Error(scrub.refused);
  redactNotices(scrub.ability, findings);
  refuseSurvivingLeaks(scrub.ability);
  return {
    file: entry.file,
    text: JSON.stringify(scrub.ability, null, 2) + "\n",
    ability: scrub.ability,
    findings,
  };
}

/** Lint findings about a value pinned into the runnable file are removable without losing it. */
function redactNotices(ability: Ability, findings: PublishFinding[]): void {
  for (const finding of findings) {
    if (finding.code === "input_single_value") deleteInputKey(ability, finding.path, "enum");
    else if (finding.code === "input_recorded_value" || finding.code === "account_id")
      deleteInputKey(ability, finding.path);
  }
}

function deleteInputKey(ability: Ability, path: string, only?: string): void {
  const [head, name, key] = path.split(".");
  if (head !== "inputs" || !name || !key || path.split(".").length !== 3) return;
  if (only && key !== only) return;
  const inputs = ability.inputs as { properties?: Record<string, Record<string, unknown>> };
  const spec = inputs.properties?.[name];
  if (spec) delete spec[key];
}

const LEAK_CODES = new Set([
  "secret",
  "personal_data",
  "account_id",
  "input_recorded_value",
  "input_single_value",
]);

/** A private value the scrub could not remove stops the pack in either mode. */
function refuseSurvivingLeaks(ability: Ability): void {
  const leaks = lintPublicAbility(ability).filter((finding) => LEAK_CODES.has(finding.code));
  if (!leaks.length) return;
  const shown = leaks
    .slice(0, 4)
    .map((finding) => formatFinding(finding))
    .join("; ");
  throw new Error(
    `ABILITY_NOT_PUBLISHABLE: ${ability.name} would ship a private value (${shown}). Fix it before packing.`,
  );
}

/** Writes a public definition per ability; blocks the pack when the lint finds an error. */
function publishAbilities(
  entries: SharedAbility[],
  add: (path: string, text: string) => void,
  redactor: ReturnType<typeof createRedactor>,
  mode: "block" | "warn",
): { published: number; findings: (PublishFinding & { ability: string })[] } {
  const findings: (PublishFinding & { ability: string })[] = [];
  let published = 0;
  for (const entry of entries) {
    findings.push(...entry.findings);
    if (!entry.ability) continue;
    const definition = redactor.json(publicAbility(entry.ability));
    add(
      `abilities/public/${abilitySlug(entry.ability.name)}.json`,
      JSON.stringify(definition, null, 2) + "\n",
    );
    published += 1;
  }
  refuseUnpublishable(findings, mode);
  return { published, findings };
}

function refuseUnpublishable(
  findings: (PublishFinding & { ability: string })[],
  mode: "block" | "warn",
): void {
  const errors = findings.filter((finding) => finding.severity === "error");
  if (!errors.length || mode === "warn") return;
  const shown = errors.slice(0, 4).map(formatFinding).join("; ");
  const more = errors.length > 4 ? `; and ${errors.length - 4} more` : "";
  throw new Error(
    `ABILITY_NOT_PUBLISHABLE: ${shown}${more}. Fix them, or share it unreviewed (publish: "warn" / --warn).`,
  );
}

function parseAbility(text: string): Ability | undefined {
  try {
    const value = JSON.parse(text) as Ability;
    return value && typeof value.name === "string" && Array.isArray(value.ways) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function flowFiles(folder: string): Promise<string[]> {
  if (!existsSync(folder)) return [];
  const names = await readdir(folder);
  return names.filter((name) => !SKIP.test(name) && !name.endsWith(".tmp")).sort();
}

function safePath(path: string): string {
  const normal = path.replaceAll("\\", "/");
  if (normal.startsWith("/") || /^[a-z]:/i.test(normal) || normal.split("/").includes(".."))
    throw new Error(`Unsafe path in pack: ${path}`);
  return normal;
}

function text(value: Uint8Array | undefined): string | undefined {
  return value ? strFromU8(value) : undefined;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "boost"
  );
}
