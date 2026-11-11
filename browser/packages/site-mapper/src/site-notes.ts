// Site notes are facts, not prose. A page the agent read cannot leave an instruction that
// later visits load into the prompt. Each fact is a short key and value of a fixed kind.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { siteDir, siteName } from "./registry.js";

export type SiteNoteKind = "selector" | "url" | "pace" | "quirk" | "page" | "control";

export interface SiteNote {
  kind: SiteNoteKind;
  key: string;
  value: string;
}

const KEY_MAX = 40;
const VALUE_MAX = 120;
const FACT_MAX = 240;
const NOTES_JSON = "notes.json";
const NOTES_MD = "notes.md";
const KINDS = new Set<SiteNoteKind>(["selector", "url", "pace", "quirk", "page", "control"]);
const KIND_CAP: Record<SiteNoteKind, number> = {
  selector: 30,
  url: 30,
  pace: 8,
  quirk: 30,
  page: 30,
  control: 40,
};

const INSTRUCTION =
  /\b(ignore|disregard|override)\b.{0,60}\b(instruction|instructions|prompt|rule|rules|above|previous)\b|\byou are now\b|\bdo not (tell|mention|reveal|ask)\b|\bwithout asking\b|\b(exfiltrate|jailbreak)\b|\bsend\b.{0,40}\b(password|cookie|cookies|token|secret|credential)s?\b|\bnew instructions?\b|\bfrom now on\b|\bsystem prompt\b/i;

export async function readSiteNotes(site: string): Promise<string> {
  return renderSiteNotes(await readSiteFacts(site));
}

export async function readSiteFacts(site: string): Promise<SiteNote[]> {
  const stored = await readStored(site);
  if (stored) return stored;
  const legacy = await readLegacy(site);
  if (!legacy.trim()) return [];
  const facts = factsFromText(legacy);
  await writeFacts(site, facts);
  return facts;
}

export async function writeSiteNotes(
  site: string,
  markdown: string,
  options: { append?: boolean } = {},
): Promise<string> {
  const incoming = factsFromText(markdown).filter((fact) => originOk(site, fact));
  const facts = options.append ? mergeFacts(await readSiteFacts(site), incoming) : incoming;
  return writeFacts(site, facts);
}

/** Saves one fact. An instruction, a long sentence, or the wrong shape is dropped. */
export async function saveSiteNote(site: string, input: unknown): Promise<string> {
  const current = await readSiteFacts(site);
  const fact = acceptSiteNote(input);
  if (!fact || !originOk(site, fact)) return renderSiteNotes(current);
  const facts = mergeFacts(current, [fact]);
  await writeFacts(site, facts);
  return renderSiteNotes(facts);
}

export function renderSiteNotes(facts: readonly SiteNote[]): string {
  return facts.map((fact) => `${fact.kind} ${fact.key}: ${fact.value}`).join("\n");
}

export function factsFromText(text: string): SiteNote[] {
  const facts: SiteNote[] = [];
  for (const line of proseLines(stripCode(text)))
    for (const clause of clauses(line)) addFact(facts, factFromLine(clause));
  return facts.slice(0, FACT_MAX);
}

export function acceptSiteNote(input: unknown): SiteNote | undefined {
  const note = asNote(input);
  if (!note || isInstruction(note.key) || isInstruction(note.value)) return undefined;
  if (isInstruction(`${note.key} ${note.value}`) || !kindFits(note)) return undefined;
  return note;
}

export function isInstruction(text: string): boolean {
  return INSTRUCTION.test(text);
}

function asNote(input: unknown): SiteNote | undefined {
  if (!input || typeof input !== "object") return undefined;
  const body = input as { kind?: unknown; key?: unknown; value?: unknown };
  if (typeof body.kind !== "string" || !KINDS.has(body.kind as SiteNoteKind)) return undefined;
  const key = cleanKey(body.key);
  const value = cleanValue(body.value);
  if (!key || !value) return undefined;
  return { kind: body.kind as SiteNoteKind, key, value };
}

function kindFits(note: SiteNote): boolean {
  if (note.kind === "selector") return isSelector(note.value);
  if (note.kind === "url") return isUrl(note.value);
  if (note.kind === "pace") return isPace(note.value) || isPace(note.key);
  if (note.kind === "page") return isPageFact(note.value);
  if (note.kind === "control") return isControl(note.value);
  return !isCode(note.value);
}

function factFromLine(line: string): SiteNote | undefined {
  const text = line.replace(/\s+/g, " ").trim();
  if (!text || text.length > VALUE_MAX || isInstruction(text) || isCode(text)) return undefined;
  const parts = splitKey(text);
  if (!parts || isInstruction(parts.key) || isInstruction(parts.value)) return undefined;
  return { kind: kindOf(parts.key, parts.value), key: parts.key, value: parts.value };
}

function kindOf(key: string, value: string): SiteNoteKind {
  if (isUrl(value) || isUrl(key)) return "url";
  if (isPace(value) || isPace(key)) return "pace";
  if (isSelector(value)) return "selector";
  return "quirk";
}

function splitKey(line: string): { key: string; value: string } | undefined {
  const match = /^([^:]{1,40}):\s*(.+)$/.exec(line);
  if (!match) return { key: slug(line), value: line };
  const key = match[1]?.trim() ?? "";
  const value = match[2]?.trim() ?? "";
  if (!key || key.length > KEY_MAX || !value || value.length > VALUE_MAX) return undefined;
  return { key, value };
}

function clauses(line: string): string[] {
  if (line.length <= VALUE_MAX) return [line];
  return line.split(/;\s*/).filter((part) => part.length > 0 && part.length <= VALUE_MAX);
}

function proseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^#+\s*/, "")
        .replace(/^[-*]\s*/, "")
        .trim(),
    )
    .filter((line) => line.length > 0 && !line.startsWith("```"));
}

function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "\n");
}

function addFact(facts: SiteNote[], fact: SiteNote | undefined): void {
  if (!fact || facts.length >= FACT_MAX) return;
  const index = facts.findIndex((item) => item.kind === fact.kind && item.key === fact.key);
  if (index >= 0) {
    facts[index] = fact;
    return;
  }
  const count = facts.filter((item) => item.kind === fact.kind).length;
  if (count >= KIND_CAP[fact.kind]) return;
  facts.push(fact);
}

function mergeFacts(current: readonly SiteNote[], incoming: readonly SiteNote[]): SiteNote[] {
  const facts = [...current];
  for (const fact of incoming) addFact(facts, fact);
  return facts;
}

function originOk(site: string, note: SiteNote): boolean {
  const want =
    site
      .replace(/^www\./, "")
      .split("/")[0]
      ?.toLowerCase() ?? "";
  const hosts = [...note.value.matchAll(/https?:\/\/([^/\s]+)/gi)].map((match) =>
    (match[1] ?? "").replace(/^www\./, "").toLowerCase(),
  );
  return hosts.every((host) => host === want || host.endsWith(`.${want}`));
}

function isPageFact(value: string): boolean {
  return /^\/[^\s|]{1,80} sig:[0-9a-f]{6,12}$/.test(value);
}

function isControl(value: string): boolean {
  return /^(role|css|text)=/.test(value) && !/[.!?]\s/.test(value) && !/https?:/i.test(value);
}

function isSelector(value: string): boolean {
  if (value.length > VALUE_MAX || /\s{2,}|[.!?]\s/.test(value)) return false;
  return (
    /^(#[\w-]+|\.[\w-]+|\[[^\]]+\])$/.test(value) ||
    /^[\w-]+(\[[^\]]+\]|\.[\w-]+)+$/.test(value) ||
    /^[\w.#[\]-]+(?:\s*[>+~]\s*[\w.#[\]-]+)+$/.test(value)
  );
}

function isUrl(value: string): boolean {
  if (value.length > VALUE_MAX || /^\s*javascript:/i.test(value)) return false;
  return /^https?:\/\/[^\s]+$/i.test(value) || /^\/[^\s]+$/.test(value);
}

function isPace(value: string): boolean {
  return /\b\d+\s*(ms|s|sec|secs|seconds)\b|\bper\s+second\b|\brequests?\s*\/\s*s\b|\bpace\b|\bthrottl/i.test(
    value,
  );
}

function isCode(line: string): boolean {
  return /=>|\bfunction\b|\b(const|let|var)\s+\w+\s*=|\breturn\s+[\w{([]|\beval\s*\(|document\.cookie|<script|\bfetch\s*\(/i.test(
    line,
  );
}

function cleanKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > KEY_MAX) return undefined;
  return text;
}

function cleanValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > VALUE_MAX) return undefined;
  return text;
}

function slug(line: string): string {
  const words = line
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 4);
  return words.join("-").slice(0, KEY_MAX) || "note";
}

async function readStored(site: string): Promise<SiteNote[] | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(siteDir(siteName(site)), NOTES_JSON), "utf8"),
    ) as { facts?: unknown };
    if (!Array.isArray(parsed.facts)) return [];
    return parsed.facts.flatMap((item) => {
      const fact = acceptSiteNote(item);
      return fact ? [fact] : [];
    });
  } catch {
    return undefined;
  }
}

async function readLegacy(site: string): Promise<string> {
  try {
    return await readFile(join(siteDir(siteName(site)), NOTES_MD), "utf8");
  } catch {
    return "";
  }
}

async function writeFacts(site: string, facts: readonly SiteNote[]): Promise<string> {
  const folder = siteDir(siteName(site));
  await mkdir(folder, { recursive: true });
  const path = join(folder, NOTES_JSON);
  const clean = facts.slice(0, FACT_MAX);
  await writeFile(path, JSON.stringify({ facts: clean }, null, 2) + "\n", "utf8");
  const rendered = renderSiteNotes(clean);
  await writeFile(join(folder, NOTES_MD), rendered ? rendered + "\n" : "", "utf8");
  return path;
}
