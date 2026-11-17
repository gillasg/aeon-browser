// A secret typed into a page or carried by a request must not land in abilities/*.json. Saving
// runs the same redactor packs use over the whole ability: a credential in an api request drops
// that way, a typed secret becomes a caller-supplied input with no example, and a test case keeps
// its shape with the value blanked. This is hygiene, never a permission gate.

import { unusedInputs } from "./ability-contract.js";
import type {
  Ability,
  AbilityScrubbed,
  AbilityVia,
  AbilityWay,
  AbilityWayApi,
} from "./abilities.js";
import { createRedactor, type Redactor } from "./redact.js";

export interface ScrubMark {
  where: "way" | "test" | "ability";
  via?: AbilityVia;
  what: string;
  /** The way is no longer stored: the secret was its whole request. */
  dropped: boolean;
  reason: "secret" | "personal";
  /** The position in the stored JSON, for telling two marks apart. */
  path?: string;
}

export interface AbilityScrub {
  ability: Ability;
  marks: ScrubMark[];
  /** Why nothing safe is left to save, when every way carried a secret. */
  refused?: string;
}

export interface ScrubOptions {
  /** A stats save keeps a redacted last way, so recording a finished run never fails. */
  keepLast?: boolean;
}

interface Found {
  path: string;
  reason: "secret" | "personal";
}

const TYPING = new Set(["fill", "type", "select", "choose", "setValue", "setvalue", "upload"]);
const SECRET_NAME =
  /password|passcode|passwd|secret|token|otp|cvv|cvc|api[_-]?key|authorization|security code|card number/i;
const JWT = /\beyJ[\w-]{6,4096}\.[\w-]{6,8192}\.[\w-]{6,4096}\b/;
// A credential written into code (script ways are a string, so key-name checks never see it).
const CREDENTIAL =
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:authorization|api[_-]?key|apikey|x-api-key|access[_-]?token|secret[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i;
// The same credential, with its value captured so it can be templated into a caller input before
// the scrub sees it. Bracket notation in the replacement (inputs["x"]) keeps it from re-matching.
const SCRIPT_CREDENTIAL =
  /(?<scheme>\b(?:Bearer|Basic))\s+(?<token>[A-Za-z0-9._~+/=-]{8,})|(?<key>\b(?:authorization|api[_-]?key|apikey|x-api-key|access[_-]?token|secret[_-]?key))\b\s*[:=]\s*(?<quote>["']?)(?<value>[A-Za-z0-9._~+/=-]{8,})\k<quote>/gi;

export function scrubAbility(
  ability: Ability,
  redactor: Redactor = createRedactor(),
  options: ScrubOptions = {},
): AbilityScrub {
  const next = structuredClone(ability);
  const marks = templateTypedSecrets(next);
  templateScriptCredentials(next, marks);
  const found: Found[] = [];
  const cleaned = scrubValue(next, "", undefined, found, redactor) as Ability;
  const ways = settleWays(cleaned, found, options, marks);
  cleaned.ways = ways;
  settleTests(cleaned, found, marks);
  settleOther(found, marks);
  scrubInputExamples(cleaned, marks);
  if (marks.some((mark) => mark.dropped)) pruneInputs(cleaned);
  settleInventory(cleaned, marks);
  const refused = ability.ways.length && !ways.length ? refusal(ability, marks) : undefined;
  return { ability: cleaned, marks, ...(refused ? { refused } : {}) };
}

/** A typed secret becomes a caller-supplied input; the value itself is never kept. */
function templateTypedSecrets(ability: Ability): ScrubMark[] {
  const marks: ScrubMark[] = [];
  for (const way of ability.ways) {
    if (way.kind !== "steps" || !Array.isArray(way.steps)) continue;
    for (const step of way.steps) {
      if (!isTypedSecret(step)) continue;
      const field = String(step.target?.name ?? "secret");
      const upload = step.kind === "upload";
      const name = secretInputName(field, ability, upload);
      step.args = secretArgs(step.args, `{{inputs.${name}}}`);
      way.redacted = true;
      marks.push({
        where: "way",
        via: "steps",
        what: `steps: ${field}`,
        dropped: false,
        reason: "secret",
      });
    }
  }
  return marks;
}

/**
 * A script that hard-codes a key cannot be replayed safely as-is. Instead of dropping it, point
 * the literal at a caller input (which is never stored) so the way survives without the secret.
 */
function templateScriptCredentials(ability: Ability, marks: ScrubMark[]): void {
  for (const way of ability.ways) {
    if (way.kind !== "script" || typeof way.code !== "string") continue;
    const code = way.code;
    let used = 0;
    const next = code.replace(SCRIPT_CREDENTIAL, (whole, ...rest: unknown[]) => {
      const groups = rest[rest.length - 1] as Record<string, string | undefined>;
      const offset = rest[rest.length - 3] as number;
      used += 1;
      if (groups.scheme && groups.token) {
        const ref = `inputs[${JSON.stringify(credentialInputName(groups.scheme, ability))}]`;
        const quote = enclosingQuote(code, offset);
        const splice = quote === "`" ? `\${${ref}}` : quote ? `${quote} + ${ref} + ${quote}` : ref;
        return whole.replace(groups.token, splice);
      }
      const name = credentialInputName(groups.key ?? "secret", ability);
      const quoted = `${groups.quote ?? ""}${groups.value ?? ""}${groups.quote ?? ""}`;
      return whole.replace(quoted, `inputs[${JSON.stringify(name)}]`);
    });
    if (!used) continue;
    way.code = next;
    way.redacted = true;
    marks.push({
      where: "way",
      via: "script",
      what: "script: credential templated to a caller input",
      dropped: false,
      reason: "secret",
    });
  }
}

/** A stable, unique input name for a credential found in a script. */
function credentialInputName(key: string, ability: Ability): string {
  const base = /authorization|bearer|basic/i.test(key)
    ? "authToken"
    : /api[_-]?key/i.test(key)
      ? "apiKey"
      : /access[_-]?token/i.test(key)
        ? "accessToken"
        : /secret[_-]?key/i.test(key)
          ? "secretKey"
          : "credential";
  const properties = inputProperties(ability);
  if (!properties[base])
    properties[base] = {
      type: "string",
      description: "Supplied by the caller at run time; the value was not stored",
    };
  return base;
}

/** The quote a credential sits inside, so a token can be spliced out as valid JS. */
function enclosingQuote(code: string, index: number): "'" | '"' | "`" | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const char = code[i];
    if (char === "\\") {
      i -= 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") return char;
    if (char === "\n" || char === ";") return undefined;
  }
  return undefined;
}

function isTypedSecret(
  step: unknown,
): step is { args?: unknown[]; kind?: string; target?: { name?: string } } {
  if (!step || typeof step !== "object") return false;
  const value = step as {
    kind?: unknown;
    sensitive?: unknown;
    target?: { name?: string };
  };
  if (typeof value.kind !== "string" || !TYPING.has(value.kind)) return false;
  return value.sensitive === true || SECRET_NAME.test(value.target?.name ?? "");
}

/** Only the argument that carried the secret is templated; a select keeps its label, and an
 * upload keeps the upload step with a workspace-path input. */
function secretArgs(args: unknown[] | undefined, template: string): unknown[] {
  if (!args?.length) return [template];
  return args.map((arg, index) => (index === 0 ? template : arg));
}

function secretInputName(field: string, ability: Ability, upload: boolean): string {
  const properties = inputProperties(ability);
  const base = camel(field) || "secret";
  if (properties[base]) return base;
  properties[base] = {
    type: "string",
    ...(upload ? { format: "path", "x-upload": true } : {}),
    description: upload
      ? "Workspace path of the file to upload; the value was not stored"
      : "Typed during the run; the value was not stored",
  };
  return base;
}

function inputProperties(ability: Ability): Record<string, Record<string, unknown>> {
  const inputs = ability.inputs as Record<string, unknown>;
  if (inputs.properties && typeof inputs.properties === "object")
    return inputs.properties as Record<string, Record<string, unknown>>;
  // Old abilities kept inputs as a flat name → spec map; keep them as properties.
  const flat =
    inputs.type === undefined
      ? Object.fromEntries(Object.entries(inputs).filter(([key]) => !SCHEMA_KEYS.has(key)))
      : {};
  ability.inputs = { type: "object", properties: flat };
  return flat as Record<string, Record<string, unknown>>;
}

const SCHEMA_KEYS = new Set([
  "type",
  "required",
  "additionalProperties",
  "description",
  "title",
  "$schema",
  "$ref",
  "anyOf",
  "oneOf",
  "allOf",
  "definitions",
  "$defs",
  "default",
  "example",
  "examples",
  "nullable",
  "format",
  "enum",
]);

function scrubValue(
  value: unknown,
  path: string,
  key: string | undefined,
  found: Found[],
  redactor: Redactor,
): unknown {
  if (typeof value === "string") return scrubString(value, path, key, found, redactor);
  if (typeof value === "number" || typeof value === "boolean") {
    if (key && SECRET_NAME.test(key)) return redacted(path, found);
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, index) =>
      scrubValue(item, joinPath(path, String(index)), undefined, found, redactor),
    );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        scrubValue(item, joinPath(path, name), name, found, redactor),
      ]),
    );
  return value;
}

function joinPath(path: string, segment: string): string {
  return path ? `${path}/${segment}` : segment;
}

function scrubString(
  value: string,
  path: string,
  key: string | undefined,
  found: Found[],
  redactor: Redactor,
): string {
  if (!value || value === "<redacted>") return value;
  const templated = /\{\{[^{}]*\}\}/.test(value);
  if (key && SECRET_NAME.test(key) && !templated) {
    found.push({ path, reason: "secret" });
    return "<redacted>";
  }
  const credential = scrubCredential(value, path, found);
  if (credential !== undefined) return credential;
  const url = scrubUrlField(value, path, key, found);
  if (url !== undefined) return url;
  if (templated) return value;
  const text = redactor.text(value);
  if (text !== value) {
    found.push({ path, reason: "personal" });
    return text;
  }
  return value;
}

/** A JWT or a credential literal written into a value; the redacted text is returned. */
function scrubCredential(value: string, path: string, found: Found[]): string | undefined {
  if (JWT.test(value)) {
    found.push({ path, reason: "secret" });
    return value.replace(JWT, "<redacted>");
  }
  if (!CREDENTIAL.test(value)) return undefined;
  found.push({ path, reason: "secret" });
  return "<redacted>";
}

function scrubUrlField(
  value: string,
  path: string,
  key: string | undefined,
  found: Found[],
): string | undefined {
  if (key !== "url" && key !== "open") return undefined;
  const cleaned = scrubUrl(value);
  if (cleaned === value) return undefined;
  found.push({ path, reason: "secret" });
  return cleaned;
}

/** Credentials in a URL: userinfo and a query value that names a credential. */
function scrubUrl(url: string): string {
  let out = url.replace(/(\/\/)([^/@\s]+)@/, "$1<redacted>@");
  out = out.replace(/([?&])([^=&#]+)=([^&#]*)/g, (whole, separator: string, key: string, value) => {
    if (!value || value.includes("{")) return whole;
    if (!SECRET_NAME.test(key) && !/^(auth|sig|signature|session)$/i.test(key)) return whole;
    return `${separator}${key}=<redacted>`;
  });
  return out;
}

function redacted(path: string, found: Found[]): string {
  found.push({ path, reason: "secret" });
  return "<redacted>";
}

function settleWays(
  ability: Ability,
  found: Found[],
  options: ScrubOptions,
  marks: ScrubMark[],
): AbilityWay[] {
  const info = wayMarks(found);
  const keep: AbilityWay[] = [];
  ability.ways.forEach((way, index) => {
    const marksHere = info.get(index);
    if (!marksHere) {
      keep.push(way);
      return;
    }
    // A script that hard-codes a credential cannot be replayed safely; drop it like an api way.
    const droppable = marksHere.secret;
    if (droppable) {
      marks.push({
        where: "way",
        via: way.kind,
        what: whatOf(way),
        dropped: true,
        reason: "secret",
      });
      return;
    }
    way.redacted = true;
    keep.push(way);
    marks.push({
      where: "way",
      via: way.kind,
      what: whatOf(way),
      dropped: false,
      reason: marksHere.secret ? "secret" : "personal",
    });
  });
  return keepLastWay(ability, keep, options.keepLast === true, marks);
}

/** A stats save keeps one redacted way, so recording a finished run never throws. */
function keepLastWay(
  ability: Ability,
  keep: AbilityWay[],
  wanted: boolean,
  marks: ScrubMark[],
): AbilityWay[] {
  if (keep.length || !wanted || !ability.ways.length) return keep;
  const first = ability.ways[0];
  if (!first) return keep;
  first.redacted = true;
  const mark = marks.find((item) => item.where === "way" && item.dropped);
  if (mark) {
    mark.dropped = false;
    mark.what = whatOf(first);
  }
  return [first];
}

function wayMarks(found: Found[]): Map<number, { secret: boolean; personal: boolean }> {
  const info = new Map<number, { secret: boolean; personal: boolean }>();
  for (const item of found) {
    const match = /^ways\/(\d+)\//.exec(item.path);
    if (!match) continue;
    const index = Number(match[1]);
    const here = info.get(index) ?? { secret: false, personal: false };
    here[item.reason] = true;
    info.set(index, here);
  }
  return info;
}

function whatOf(way: AbilityWay): string {
  if (way.kind !== "api") return way.kind;
  const api = way as AbilityWayApi;
  const operation = api.operation ?? api.operations?.[0]?.operation;
  return operation ? `api ${operation}` : "api";
}

function settleTests(ability: Ability, found: Found[], marks: ScrubMark[]): void {
  for (const [index, test] of (ability.tests ?? []).entries()) {
    if (!found.some((item) => item.path.startsWith(`tests/${index}/`))) continue;
    test.redacted = true;
    test.inputs = blankTestValues(test.inputs) as Record<string, unknown>;
    marks.push({ where: "test", what: `test ${index + 1}`, dropped: false, reason: "secret" });
  }
}

/** A redaction outside a way or a test still belongs in the inventory. */
function settleOther(found: Found[], marks: ScrubMark[]): void {
  for (const item of found) {
    if (item.path.startsWith("ways/") || item.path.startsWith("tests/")) continue;
    if (marks.some((mark) => mark.path === item.path)) continue;
    marks.push({
      where: "ability",
      what: whatAt(item.path),
      dropped: false,
      reason: item.reason,
      path: item.path,
    });
  }
}

function whatAt(path: string): string {
  const [head = "text", ...rest] = path.split("/");
  if (head === "inputs") return `input ${rest[rest.length - 1] ?? ""}`.trim();
  return head;
}

/** A test's secret example is not sent as "<redacted>"; the case keeps its shape with "". */
function blankTestValues(value: unknown): unknown {
  if (typeof value === "string") return /^<[a-z]+>$/.test(value) ? "" : value;
  if (Array.isArray(value)) return value.map(blankTestValues);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, blankTestValues(item)]),
    );
  return value;
}

function scrubInputExamples(ability: Ability, marks: ScrubMark[]): void {
  const properties = inputProperties(ability);
  for (const [name, spec] of Object.entries(properties)) {
    if (!SECRET_NAME.test(name)) continue;
    if (spec.example === undefined && spec.default === undefined) continue;
    delete spec.example;
    delete spec.default;
    marks.push({
      where: "ability",
      what: `input ${name}`,
      dropped: false,
      reason: "secret",
    });
  }
}

/** Inputs only the dropped way used are no longer declared. */
function pruneInputs(ability: Ability): void {
  const properties = inputProperties(ability);
  const required = (ability.inputs as { required?: unknown }).required;
  for (const name of unusedInputs(ability)) {
    delete properties[name];
    if (Array.isArray(required)) {
      const index = required.indexOf(name);
      if (index >= 0) required.splice(index, 1);
    }
  }
}

function settleInventory(ability: Ability, marks: ScrubMark[]): void {
  if (!marks.length) return;
  const at = new Date().toISOString();
  const entries: AbilityScrubbed[] = marks.map((mark) => ({
    at,
    where: mark.where,
    ...(mark.via ? { via: mark.via } : {}),
    what: mark.what,
    dropped: mark.dropped,
    reason: mark.reason,
  }));
  const known = new Set(
    (ability.scrubbed ?? []).map((item) => `${item.where}|${item.via ?? ""}|${item.what}`),
  );
  const fresh = entries.filter(
    (item) => !known.has(`${item.where}|${item.via ?? ""}|${item.what}`),
  );
  if (fresh.length) ability.scrubbed = [...(ability.scrubbed ?? []), ...fresh].slice(-20);
}

function refusal(ability: Ability, marks: ScrubMark[]): string {
  const what = marks.find((mark) => mark.dropped)?.what ?? "its only way";
  return (
    `ABILITY_ONLY_SECRET: ${ability.site} ${ability.name}: ${what} carried a secret, and no ` +
    "replayable way is left. Save it without the secret, or sign in and record it again."
  );
}

function camel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => (index ? word[0]?.toUpperCase() + word.slice(1) : word))
    .join("")
    .slice(0, 32);
}
