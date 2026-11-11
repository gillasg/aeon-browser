// Facts learned from a run, stored in the site's notes. No second store: page types, control
// fallbacks, quirks and pace are notes.

import { createHash } from "node:crypto";
import { templatePaths } from "./infer/templates.js";
import { readSiteFacts, saveSiteNote, type SiteNote } from "./site-notes.js";

export interface PageSeen {
  url: string;
  landmarks: string[];
  headings: string[];
  controls: string[];
}

export interface ControlSeen {
  role?: string;
  name?: string;
  css?: string;
  text?: string;
}

export interface RunKnowledge {
  pages?: PageSeen[];
  controls?: ControlSeen[];
  quirks?: { key: string; value: string }[];
  pace?: string;
}

/** Hash of landmark, heading and control names. Eight hex characters. */
export function structuralSignature(
  landmarks: readonly string[],
  headings: readonly string[],
  controls: readonly string[],
): string {
  const text = [landmarks, headings, controls]
    .map((list) =>
      [...list]
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join("|"),
    )
    .join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** Path template for one URL. Ids become `{name}`; a bad URL is skipped. */
export function patternOf(url: string): string | undefined {
  try {
    const templated = templatePaths([{ url }])[0];
    if (!templated) return undefined;
    return withQuery(url, templated.template);
  } catch {
    return undefined;
  }
}

/** Saves what a run showed. Cross-origin URLs and long sentences are dropped by the notes store. */
export async function rememberRun(site: string, run: RunKnowledge): Promise<number> {
  const facts = knowledgeFacts(site, run);
  let saved = 0;
  for (const fact of facts) {
    const before = await readSiteFacts(site);
    await saveSiteNote(site, fact);
    const after = await readSiteFacts(site);
    if (after.length > before.length || replaced(before, after, fact)) saved += 1;
  }
  return saved;
}

function replaced(
  before: readonly SiteNote[],
  after: readonly SiteNote[],
  fact: SiteNote,
): boolean {
  const next = after.find((item) => item.kind === fact.kind && item.key === fact.key);
  const prev = before.find((item) => item.kind === fact.kind && item.key === fact.key);
  return Boolean(next && next.value !== prev?.value);
}

function knowledgeFacts(site: string, run: RunKnowledge): SiteNote[] {
  const facts: SiteNote[] = [];
  for (const page of run.pages ?? []) pushPage(facts, site, page);
  for (const control of run.controls ?? []) pushControl(facts, control);
  for (const quirk of run.quirks ?? []) push(facts, "quirk", quirk.key, quirk.value);
  if (run.pace) push(facts, "pace", "pace", run.pace);
  return facts;
}

function pushPage(facts: SiteNote[], site: string, page: PageSeen): void {
  if (!sameHost(site, [page.url]).length && /^https?:/i.test(page.url)) return;
  const pattern = patternOf(page.url);
  if (!pattern) return;
  const signature = structuralSignature(page.landmarks, page.headings, page.controls);
  push(facts, "page", slug(pattern), `${pattern} sig:${signature}`);
}

function pushControl(facts: SiteNote[], control: ControlSeen): void {
  const parts = [
    control.role ? `role=${control.role}` : "",
    control.name ? `name=${control.name}` : "",
    control.css ? `css=${control.css}` : "",
    control.text ? `text=${control.text}` : "",
  ].filter(Boolean);
  if (!parts.length) return;
  push(
    facts,
    "control",
    slug(control.name || control.role || control.css || "control"),
    parts.join(";"),
  );
}

function push(facts: SiteNote[], kind: SiteNote["kind"], key: string, value: string): void {
  const cleanKey = key.replace(/\s+/g, " ").trim().slice(0, 40);
  const cleanValue = value.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!cleanKey || !cleanValue) return;
  facts.push({ kind, key: cleanKey, value: cleanValue });
}

function sameHost(site: string, urls: readonly string[]): string[] {
  const want = bareHost(site);
  return urls.filter((url) => {
    try {
      return bareHost(new URL(url).hostname) === want;
    } catch {
      return false;
    }
  });
}

function bareHost(host: string): string {
  return host.replace(/^www\./, "").toLowerCase();
}

function withQuery(url: string, path: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return path;
  }
  const keys = [...parsed.searchParams.keys()].slice(0, 4);
  if (!keys.length) return path;
  const full = `${path}?${keys.join("&")}`;
  return full.length <= 100 ? full : path;
}

function slug(value: string): string {
  const text = value
    .toLowerCase()
    .replace(/\{([^}]+)\}/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return text || "fact";
}
