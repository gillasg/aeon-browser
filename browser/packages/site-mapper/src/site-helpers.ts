// Helper scripts: reusable browser_code snippets for one or more hosts (the old SiteSkill store).
// Each helper is a `kind: "script"`, `source: "helper"` op in the `api.json` of every host it
// names, and is documented in that host's `SKILL.md`. An agent's save passes the same filter as
// site notes: no instructions in the prose, no links to other sites. Site-pack imports and the
// user's own edits are not filtered.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { registryRoot, siteName } from "./registry.js";
import { isInstruction, refreshSiteSkill } from "./site-notes.js";
import { readOpsFile, writeOpsFile, type SiteOp } from "./site-ops-file.js";

export interface SiteHelper {
  name: string;
  domains: string[];
  description: string;
  examples: string;
  code: string;
  enabled?: boolean;
  updatedAt: number;
}

export type HelperAuthor = "agent" | "user";

const DOMAIN = /^(\*\.)?[a-z0-9.-]+(?::\d{1,5})?$/;

export function validHelperName(name: unknown): string {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
    throw new Error("Skill names use lowercase letters, digits and dashes");
  return name;
}

export function validHelper(skill: Partial<SiteHelper> | undefined): SiteHelper {
  const domains = (skill?.domains ?? []).map((domain) => String(domain).toLowerCase().trim());
  if (!domains.length || domains.length > 16 || domains.some((d) => !DOMAIN.test(d)))
    throw new Error("Skill domains must be host names such as example.com or *.example.com");
  const code = text(skill?.code, 64000, "code");
  if (!code.trim()) throw new Error("Skill code is required");
  return {
    name: validHelperName(skill?.name),
    domains,
    description: text(skill?.description, 2000, "description"),
    examples: text(skill?.examples, 4000, "examples"),
    code,
    enabled: skill?.enabled !== false,
    updatedAt: Date.now(),
  };
}

function text(value: unknown, max: number, label: string): string {
  const result = typeof value === "string" ? value : "";
  if (result.length > max) throw new Error(`Skill ${label} exceeds ${max} characters`);
  return result;
}

/** An agent's helper prose may not instruct, and may only link to the hosts it is for. */
export function helperProblem(helper: SiteHelper): string | undefined {
  const prose = `${helper.description}\n${helper.examples}`;
  if (isInstruction(prose)) return "SKILL_REJECTED: the description reads as an instruction";
  const hosts = [...prose.matchAll(/https?:\/\/([^/\s"'`)]+)/gi)].map((match) =>
    (match[1] ?? "").replace(/^www\./, "").toLowerCase(),
  );
  const own = hosts.every((host) => helper.domains.some((domain) => domainMatches(host, domain)));
  return own ? undefined : "SKILL_REJECTED: a link points to another site";
}

export function domainMatches(host: string, domain: string): boolean {
  if (!hasPort(domain)) host = stripPort(host);
  if (domain.startsWith("*.")) return host === domain.slice(2) || host.endsWith(domain.slice(1));
  return host === domain || host.endsWith("." + domain);
}

function hasPort(value: string): boolean {
  return /^\[[^\]]*\]:\d+$/.test(value) || /^[^:[\]]+:\d+$/.test(value);
}

function stripPort(host: string): string {
  if (host.startsWith("[")) return host.replace(/^\[([^\]]*)\](:\d+)?$/, "[$1]");
  return /^[^:]+:\d+$/.test(host) ? host.replace(/:\d+$/, "") : host;
}

/** The folder a domain's helper lives in: `*.shop.example` → `shop.example`. */
function hostOfDomain(domain: string): string {
  return siteName(domain.replace(/^\*\./, ""));
}

export async function saveHelper(
  input: Partial<SiteHelper>,
  author: HelperAuthor = "agent",
): Promise<SiteHelper> {
  const helper = validHelper(input);
  const problem = author === "agent" ? helperProblem(helper) : undefined;
  if (problem) throw new Error(problem);
  await dropHelper(helper.name);
  for (const host of new Set(helper.domains.map(hostOfDomain))) await putHelper(host, helper);
  return helper;
}

async function putHelper(host: string, helper: SiteHelper): Promise<void> {
  const ops = ((await readOpsFile(host))?.ops ?? []).filter(
    (op) => !(op.source === "helper" && op.id === helper.name),
  );
  await writeOpsFile(host, [...ops, helperOp(helper)]);
  await refreshSiteSkill(host);
}

export function helperOp(helper: SiteHelper): SiteOp {
  return {
    id: helper.name,
    kind: "script",
    source: "helper",
    code: helper.code,
    domains: helper.domains,
    description: helper.description,
    examples: helper.examples,
    enabled: helper.enabled !== false,
    updatedAt: helper.updatedAt,
  };
}

function opHelper(op: SiteOp): SiteHelper {
  return {
    name: op.id,
    domains: op.domains ?? [],
    description: op.description ?? "",
    examples: op.examples ?? "",
    code: op.code ?? "",
    enabled: op.enabled !== false,
    updatedAt: op.updatedAt ?? 0,
  };
}

/** Every helper on every site, once each, disabled ones included. */
export async function allHelpers(): Promise<SiteHelper[]> {
  const folders = await readdir(join(registryRoot(), "sites")).catch(() => [] as string[]);
  const seen = new Map<string, SiteHelper>();
  for (const folder of folders) {
    const ops = (await readOpsFile(folder.replace(/_(\d+)$/, ":$1")))?.ops ?? [];
    for (const op of ops)
      if (op.source === "helper" && !seen.has(op.id)) seen.set(op.id, opHelper(op));
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function dropHelper(name: string): Promise<boolean> {
  const folders = await readdir(join(registryRoot(), "sites")).catch(() => [] as string[]);
  let dropped = false;
  for (const folder of folders) {
    const host = folder.replace(/_(\d+)$/, ":$1");
    const ops = (await readOpsFile(host))?.ops ?? [];
    const kept = ops.filter((op) => !(op.source === "helper" && op.id === name));
    if (kept.length === ops.length) continue;
    dropped = true;
    await writeOpsFile(host, kept);
    await refreshSiteSkill(host);
  }
  return dropped;
}
