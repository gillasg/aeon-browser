// Learned sites as MCP resources: `graft://skills/<site>` reads the site's SKILL.md, with a short
// content version so a client can tell when a skill changed. A bundle heal, or any rewrite seen
// by the poll, sends `notifications/resources/updated`; a site added or removed sends list_changed.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpListResult } from "@graft/protocol";
import {
  listSites,
  onBundleHealed,
  readHealLog,
  siteDir,
  siteName,
} from "@browserkit/tools/site-to-api";

type Json = Record<string, unknown>;
type Notify = (message: Json) => void;

/** The `resources` server capability. */
export const RESOURCES = { resources: { listChanged: true } } as const;

/** A JSON-RPC error object: the thrown error's numeric `code` when it has one, else -32603. */
export function rpcError(error: unknown): { code: number; message: string } {
  const code = (error as { code?: unknown } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return { code: typeof code === "number" ? code : -32603, message };
}

export const SKILL_URI_PREFIX = "graft://skills/";
const SITE_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;

export interface SkillMeta {
  version: string;
  updatedAt?: string;
  lastHealedAt?: string;
  operations: number;
}

interface Skill {
  site: string;
  text: string;
  meta: SkillMeta;
}

/** A clean site name from a resource URI, or undefined for anything else (traversal included). */
export function skillSite(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri.startsWith(SKILL_URI_PREFIX)) return undefined;
  const site = uri.slice(SKILL_URI_PREFIX.length);
  if (!SITE_PATTERN.test(site) || site.includes("..")) return undefined;
  return site;
}

async function readSkill(site: string): Promise<Skill | undefined> {
  const dir = siteDir(site);
  const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  // Operations live in the site's model.json; api.json is the lazily compiled ops file and may
  // not exist yet. Both feed the version, so a new or changed operation bumps it.
  const modelText = await readFile(join(dir, "model.json"), "utf8").catch(() => "");
  const ops = await readFile(join(dir, "api.json"), "utf8").catch(() => "");
  const model = parseJson<{ generatedAt?: unknown; operations?: unknown[] }>(modelText);
  const parsed = parseJson<{ compiledAt?: unknown; ops?: unknown[] }>(ops);
  const healed = await readHealLog(site, { limit: 50 }).catch(() => []);
  const lastHealedAt = healed
    .filter((entry) => entry.event === "repaired")
    .map((entry) => entry.at)
    .sort()
    .pop();
  const meta: SkillMeta = {
    version: createHash("sha256")
      .update(text)
      .update("\0")
      .update(modelText)
      .update("\0")
      .update(ops)
      .digest("hex")
      .slice(0, 12),
    ...updatedAt(model.generatedAt, parsed.compiledAt),
    ...(lastHealedAt ? { lastHealedAt } : {}),
    operations: Array.isArray(model.operations)
      ? model.operations.length
      : Array.isArray(parsed.ops)
        ? parsed.ops.length
        : 0,
  };
  return { site, text, meta };
}

/** Parsed JSON, or {} for a missing or torn file (which still versions by its bytes). */
function parseJson<T extends object>(text: string): Partial<T> {
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    return value && typeof value === "object" ? (value as Partial<T>) : {};
  } catch {
    return {};
  }
}

function updatedAt(...stamps: unknown[]): { updatedAt?: string } {
  const latest = stamps
    .filter((stamp): stamp is string => typeof stamp === "string")
    .sort()
    .pop();
  return latest ? { updatedAt: latest } : {};
}

async function allSkills(): Promise<Skill[]> {
  const sites = await listSites().catch(() => []);
  const skills = await Promise.all(sites.map((entry) => readSkill(siteName(entry.site))));
  return skills.filter((skill): skill is Skill => !!skill);
}

function describe(skill: Skill): Json {
  const { meta } = skill;
  const healed = meta.lastHealedAt ? `, healed ${meta.lastHealedAt}` : "";
  return {
    uri: SKILL_URI_PREFIX + skill.site,
    name: `${skill.site} skill`,
    description: `${meta.operations} operations, version ${meta.version}${healed}.`,
    mimeType: "text/markdown",
    _meta: { ...meta },
  };
}

export async function listSkillResources(): Promise<Json[]> {
  return (await allSkills()).map(describe);
}

/** `resources/read` for one skill; throws a JSON-RPC shaped error for unknown or unsafe URIs. */
export async function readSkillResource(uri: unknown): Promise<Json> {
  const site = skillSite(uri);
  const skill = site ? await readSkill(site) : undefined;
  if (!skill) throw Object.assign(new Error(`Unknown resource ${String(uri)}`), { code: -32602 });
  return {
    contents: [
      {
        uri: SKILL_URI_PREFIX + skill.site,
        mimeType: "text/markdown",
        text: skill.text,
        _meta: { ...skill.meta },
      },
    ],
  };
}

/** resources/* and prompts/list; undefined for any other method. */
export function resourceRequest(
  method: string,
  params: Json,
  modern: boolean,
): Promise<Json> | undefined {
  if (method === "prompts/list") return Promise.resolve(mcpListResult({ prompts: [] }, modern));
  if (method === "resources/list")
    return listSkillResources().then((resources) => mcpListResult({ resources }, modern));
  if (method === "resources/templates/list")
    return Promise.resolve(mcpListResult({ resourceTemplates: [] }, modern));
  if (method === "resources/read") return readSkillResource(params.uri);
  return undefined;
}

/** Sends `notifications/resources/updated` for one site's skill. */
export function notifySkillUpdated(notify: Notify, site: string): void {
  notify({
    jsonrpc: "2.0",
    method: "notifications/resources/updated",
    params: { uri: SKILL_URI_PREFIX + siteName(site) },
  });
}

/** Watches skill versions (heal hook plus a poll); returns stop. */
export function watchSkills(notify: Notify, intervalMs = pollInterval()): () => void {
  let known: Map<string, string> | undefined;
  const check = async (): Promise<void> => {
    const next = new Map((await allSkills()).map((skill) => [skill.site, skill.meta.version]));
    if (known) {
      const sameSet = known.size === next.size && [...next.keys()].every((k) => known?.has(k));
      if (!sameSet) notify({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
      for (const [site, version] of next)
        if (known.has(site) && known.get(site) !== version) notifySkillUpdated(notify, site);
    }
    known = next;
  };
  void check().catch(() => undefined);
  const timer = setInterval(() => void check().catch(() => undefined), intervalMs);
  timer.unref();
  const stopHeal = onBundleHealed((site) => {
    // The saved model changed; recompile is lazy, so tell the client now and let the poll settle.
    notifySkillUpdated(notify, site);
  });
  return () => {
    clearInterval(timer);
    stopHeal();
  };
}

function pollInterval(): number {
  const ms = Number(process.env.GRAFT_CATALOG_POLL_MS ?? 5000);
  return Number.isFinite(ms) && ms >= 50 ? ms : 5000;
}
