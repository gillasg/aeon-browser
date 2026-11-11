// Which saved abilities a prompt is about. Word overlap only: no model call.

import { listAbilities } from "./abilities.js";

export interface AbilityMatch {
  site: string;
  name: string;
  call: string;
  score: number;
  does: "read" | "write";
}

const STOP = new Set(
  "a an the my your of for to and or on in by with from this that show get list find please me all our their is are was it you we".split(
    " ",
  ),
);
const HOST = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
const THRESHOLD = 0.5;

export function hostsNamed(prompt: string): string[] {
  const found = new Set<string>();
  for (const match of prompt.matchAll(HOST)) {
    const host = match[0].toLowerCase().replace(/^www\./, "");
    if (/\.(?:md|js|json|png|jpg|css)$/.test(host)) continue;
    found.add(host);
  }
  return [...found];
}

export function scoreAbility(
  prompt: string,
  ability: { name: string; description?: string; inputs: string[] },
): number {
  const wanted = tokens(taskText(prompt));
  const nameTokens = tokens(ability.name.replace(/[_-]+/g, " "));
  const body = new Set(
    tokens(`${ability.name} ${ability.description ?? ""} ${ability.inputs.join(" ")}`),
  );
  if (!nameTokens.some((token) => wanted.includes(token))) return 0;
  if (wanted.length >= 2 && covered(wanted, body) / wanted.length < THRESHOLD) return 0;
  const hits = nameTokens.filter((token) => wanted.includes(token)).length;
  return nameTokens.length ? hits / nameTokens.length : 0;
}

export async function matchAbilities(
  prompt: string,
  hosts: string[],
  limit = 3,
): Promise<AbilityMatch[]> {
  const found: AbilityMatch[] = [];
  for (const site of uniqueHosts([...hosts, ...hostsNamed(prompt)])) {
    const abilities = await listAbilities(site).catch(() => []);
    for (const ability of abilities) found.push(...scored(prompt, site, ability));
  }
  return found.sort((left, right) => right.score - left.score).slice(0, limit);
}

function scored(
  prompt: string,
  site: string,
  ability: { name: string; description?: string; kind: string; inputs?: Record<string, unknown> },
): AbilityMatch[] {
  const inputs = inputNames(ability.inputs);
  const score = scoreAbility(prompt, {
    name: ability.name,
    ...(ability.description ? { description: ability.description } : {}),
    inputs,
  });
  if (score < THRESHOLD) return [];
  return [
    {
      site,
      name: ability.name,
      call: callOf(site, ability.name, inputs),
      score,
      does: ability.kind === "write" ? "write" : "read",
    },
  ];
}

function inputNames(inputs: Record<string, unknown> | undefined): string[] {
  const properties = inputs?.properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.keys(properties);
}

function callOf(_site: string, name: string, inputs: string[]): string {
  const body = inputs.length ? inputs.join(", ") : "page";
  const literal = `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return `site.run(${literal}, {${body}})`;
}

function covered(wanted: string[], body: Set<string>): number {
  return wanted.filter((token) => body.has(token)).length;
}

function taskText(prompt: string): string {
  return prompt.replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, " ");
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(stem)
    .filter((word) => word.length > 1 && !STOP.has(word));
}

function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

function uniqueHosts(hosts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const host of hosts) {
    const name = host.toLowerCase().replace(/^www\./, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.slice(0, 12);
}
