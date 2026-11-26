// `SKILL.md`: the one readable file per site. The user's own text sits between markers and is
// kept as written. Facts are the site notes (parsed back on read and filtered again). Helpers
// and ops are rendered from `api.json`, so they always say what will actually run.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { siteDir, siteName, writeAtomic } from "./registry.js";
import { readOpsFile, type SiteOp } from "./site-ops-file.js";

export const SKILL_FILE = "SKILL.md";
const USER_OPEN = "<!-- aeon:user -->";
const USER_CLOSE = "<!-- /aeon:user -->";
const FACTS = "## Facts";

export interface RawFact {
  kind: string;
  key: string;
  value: string;
}

export interface SkillDoc {
  /** Written by the user; never filtered. */
  user: string;
  /** Site notes, as `kind key: value`. Filtered by the notes store on every read. */
  facts: RawFact[];
}

export function skillPath(site: string): string {
  return join(siteDir(siteName(site)), SKILL_FILE);
}

export async function readSkillFile(site: string): Promise<SkillDoc | undefined> {
  try {
    return parseSkillDoc(await readFile(skillPath(site), "utf8"));
  } catch {
    return undefined;
  }
}

export function parseSkillDoc(text: string): SkillDoc {
  const open = text.indexOf(USER_OPEN);
  const close = text.indexOf(USER_CLOSE);
  const user = open >= 0 && close > open ? text.slice(open + USER_OPEN.length, close).trim() : "";
  return { user, facts: factLines(sectionOf(text, FACTS)) };
}

/** Writes the file with the given parts; parts left out keep what the file has. */
export async function writeSkillFile(site: string, patch: Partial<SkillDoc>): Promise<string> {
  const host = siteName(site);
  const current = (await readSkillFile(host)) ?? { user: "", facts: [] };
  const doc = { ...current, ...patch };
  const ops = (await readOpsFile(host))?.ops ?? [];
  await mkdir(siteDir(host), { recursive: true });
  const path = skillPath(host);
  await writeAtomic(path, renderSkillDoc(host, doc, ops));
  return path;
}

export function renderSkillDoc(site: string, doc: SkillDoc, ops: readonly SiteOp[]): string {
  const helpers = ops.filter((op) => op.source === "helper" && op.enabled !== false);
  const compiled = ops.filter((op) => op.source !== "helper");
  const parts = [
    `# ${site}`,
    "",
    "Your notes go between the markers below; Aeon keeps them as written.",
    "",
    USER_OPEN,
    doc.user.trim(),
    USER_CLOSE,
    "",
    FACTS,
    "",
    ...doc.facts.map((fact) => `- ${fact.kind} ${fact.key}: ${fact.value}`),
    "",
    "## Helpers",
    "",
    ...helpers.map(helperLine),
    "",
    "## Ops",
    "",
    ...compiled.map(opLine),
    "",
  ];
  return parts.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function opLine(op: SiteOp): string {
  const how = op.kind === "http" && op.method && op.path ? `${op.method} ${op.path}` : op.kind;
  const extra = [
    op.fallback ? "falls back to script" : "",
    op.version ? `v${op.version}` : "",
    op.guards?.shape ? "shape-checked" : "",
    op.guards?.readBack ? `read back by ${op.guards.readBack}` : "",
  ].filter(Boolean);
  const summary = op.summary ? ` — ${oneLine(op.summary)}` : "";
  return `- \`${op.id}\` ${how}${extra.length ? ` (${extra.join(", ")})` : ""}${summary}`;
}

function helperLine(op: SiteOp): string {
  const about = op.description ? ` — ${oneLine(op.description)}` : "";
  const examples = op.examples ? `\n  examples: ${oneLine(op.examples)}` : "";
  return `- \`${op.id}\` (${(op.domains ?? []).join(", ")})${about}${examples}`;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) return "";
  const body = text.slice(start + heading.length + 2);
  const next = body.search(/^## /m);
  return next >= 0 ? body.slice(0, next) : body;
}

function factLines(section: string): RawFact[] {
  const facts: RawFact[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^- (\w+) ([^:]{1,40}): (.+)$/.exec(line.trim());
    if (match) facts.push({ kind: match[1] ?? "", key: match[2] ?? "", value: match[3] ?? "" });
  }
  return facts;
}
