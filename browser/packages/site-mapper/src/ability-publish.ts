// The reviewable face of an ability and the deterministic checks a shared one must pass. A pack
// or a published definition can be read by a stranger, so it must not carry a secret, personal
// data, an account id, an input pinned to the recorded value, or a claim the way does not keep.
// Local saves and runs are never blocked; this runs when an ability is shared.

import { abilityContent, contentDigest } from "./ability-digest.js";
import { unusedInputs } from "./ability-contract.js";
import { createRedactor, SECRET_KEYS } from "./redact.js";
import type { Ability } from "./abilities.js";
import type { AbilityWrite } from "./ability-effects.js";
import { abilityEffect, type CallEffect } from "./effect.js";

export interface PublicAbility {
  name: string;
  site: string;
  description?: string;
  effect: CallEffect;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  preconditions?: unknown;
  /** The write inventory, when the ability has one. */
  writes?: AbilityWrite[];
  ways: string[];
  /** A digest of the private content, so two versions are told apart without exposing it. */
  digest: string;
}

export type PublishSeverity = "error" | "notice";

export interface PublishFinding {
  code: string;
  path: string;
  message: string;
  severity: PublishSeverity;
}

/** What a caller needs to choose and call this ability, without its code or recorded values. */
export function publicAbility(ability: Ability): PublicAbility {
  const writes = ability.writes;
  return {
    name: ability.name,
    site: ability.site,
    ...(ability.description ? { description: ability.description } : {}),
    effect: abilityEffect(ability),
    inputs: ability.inputs,
    ...(ability.outputs ? { outputs: ability.outputs } : {}),
    ...(ability.preconditions ? { preconditions: ability.preconditions } : {}),
    ...(writes ? { writes } : {}),
    ways: ability.ways.map((way) => way.kind),
    digest: contentDigest(ability),
  };
}

/** Every deterministic check. Errors block a share unless the caller allows an unreviewed one. */
export function lintPublicAbility(ability: Ability): PublishFinding[] {
  const findings: PublishFinding[] = [];
  const content = abilityContent(ability);
  leaks(content, [], findings);
  accountIds(content, [], findings);
  inputFindings(ability, findings);
  outputFindings(ability, findings);
  claimFindings(ability, findings);
  return dedupe(findings);
}

export function publishErrors(findings: PublishFinding[]): PublishFinding[] {
  return findings.filter((finding) => finding.severity === "error");
}

/** One line per finding, for a CLI or a pack error. */
export function formatFinding(finding: PublishFinding & { ability?: string }): string {
  const where = finding.ability ? `${finding.ability} ${finding.path}` : finding.path;
  return `${finding.severity} ${finding.code} ${where}: ${finding.message}`;
}

function finding(
  severity: PublishSeverity,
  code: string,
  path: string,
  message: string,
): PublishFinding {
  return { code, path, message, severity };
}

const CREDENTIAL =
  /\b(?:sk|ghp|gho|ghu|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/;
const REDACTOR = createRedactor();
const ACCOUNT_KEY =
  /(?:^|_)(account|user|customer|org|team|member|tenant|workspace|profile|project)_?id$/i;
const READ_VERB = /^(read|list|view|get|fetch|search|find|look up|show)\b/i;
const WRITE_VERB =
  /^(delete|remove|cancel|submit|place|order|send|post|update|change|edit|create|add|book|buy)\b/i;

/** Secrets and personal data anywhere in the content, by path; the value itself is never printed. */
function leaks(value: unknown, path: string[], out: PublishFinding[]): void {
  if (typeof value === "string") {
    leakText(value, path, out);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => leaks(item, [...path, String(index)], out));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const next = [...path, key];
    if (SECRET_KEYS.test(key) && scalar(item)) {
      out.push(finding("error", "secret", next.join("."), `${key} holds what looks like a secret`));
      continue;
    }
    leaks(item, next, out);
  }
}

function leakText(value: string, path: string[], out: PublishFinding[]): void {
  const redacted = REDACTOR.text(value);
  if (CREDENTIAL.test(value)) {
    out.push(finding("error", "secret", path.join("."), "contains a credential-like literal"));
    return;
  }
  if (redacted === value) return;
  const label = leakLabel(redacted);
  out.push(finding("error", label.code, path.join("."), label.message));
}

function leakLabel(redacted: string): { code: string; message: string } {
  if (redacted.includes("<email>"))
    return { code: "personal_data", message: "contains an email address" };
  if (redacted.includes("<card>"))
    return { code: "personal_data", message: "contains a card number" };
  if (redacted.includes("<phone>"))
    return { code: "personal_data", message: "contains a phone number" };
  return { code: "secret", message: "contains a token or secret" };
}

/** Account-scoped ids pinned into a schema example/default/enum or a stored test input. */
function accountIds(value: unknown, path: string[], out: PublishFinding[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => accountIds(item, [...path, String(index)], out));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (pinnedAccount(key, item, path))
      out.push(
        finding(
          "error",
          "account_id",
          [...path, key].join("."),
          `${key} is pinned to one account's value`,
        ),
      );
    else accountIds(item, [...path, key], out);
  }
}

function pinnedAccount(key: string, item: unknown, path: string[]): boolean {
  const account =
    ACCOUNT_KEY.test(key) ||
    ((key === "default" || key === "example") && ACCOUNT_KEY.test(path.at(-1) ?? ""));
  if (!account) return false;
  if (scalar(item) && !isTemplate(item)) return true;
  return Array.isArray(item) && item.length > 0 && item.every(scalar);
}

function inputFindings(ability: Ability, out: PublishFinding[]): void {
  const properties = schemaProperties(ability.inputs);
  const required = requiredNames(ability.inputs);
  for (const name of required)
    if (!properties[name])
      out.push(
        finding(
          "error",
          "input_undeclared",
          `inputs.required.${name}`,
          `required input ${name} is not declared`,
        ),
      );
  for (const name of unusedInputs(ability))
    out.push(
      finding("error", "input_unused", `inputs.${name}`, `${name} is declared but no way uses it`),
    );
  for (const name of referencedInputs(ability))
    if (!properties[name] && !required.includes(name))
      out.push(
        finding(
          "error",
          "input_undeclared",
          "ways",
          `a way uses input ${name}, which is not declared`,
        ),
      );
  for (const [name, spec] of Object.entries(properties)) pinnedInput(name, spec, ability, out);
}

function pinnedInput(
  name: string,
  spec: Record<string, unknown>,
  ability: Ability,
  out: PublishFinding[],
): void {
  const values = Array.isArray(spec.enum) ? spec.enum : [];
  if (values.length === 1)
    out.push(
      finding(
        "error",
        "input_single_value",
        `inputs.${name}.enum`,
        `${name} allows only one value, so a caller cannot choose`,
      ),
    );
  const recorded = recordedValue(ability, name);
  if (recorded === undefined) return;
  for (const key of ["default", "example"])
    if (spec[key] !== undefined && String(spec[key]) === recorded)
      out.push(
        finding(
          "notice",
          "input_recorded_value",
          `inputs.${name}.${key}`,
          `${name} repeats the value from the recorded run`,
        ),
      );
}

function recordedValue(ability: Ability, name: string): string | undefined {
  const values = (ability.tests ?? [])
    .map((test) => test.inputs[name])
    .filter((value) => value !== undefined)
    .map((value) => JSON.stringify(value));
  const [first] = values;
  return first !== undefined && new Set(values).size === 1
    ? String(JSON.parse(first) as unknown)
    : undefined;
}

function outputFindings(ability: Ability, out: PublishFinding[]): void {
  const covered = new Set((ability.tests ?? []).flatMap((test) => Object.keys(test.expect ?? {})));
  const uncovered = Object.keys(schemaProperties(ability.outputs)).filter(
    (field) => !covered.has(field),
  );
  if (uncovered.length)
    out.push(
      finding("notice", "output_untested", "outputs", `no test expects ${uncovered.join(", ")}`),
    );
  if (ability.kind === "write" && !ability.options.readBack && !ability.postcondition)
    out.push(
      finding(
        "error",
        "write_no_readback",
        "kind",
        "a write cannot confirm that it changed the site",
      ),
    );
}

function claimFindings(ability: Ability, out: PublishFinding[]): void {
  const claim = ability.description?.trim() ?? "";
  if (!claim) return;
  if (ability.kind === "read" && WRITE_VERB.test(claim))
    out.push(
      finding("error", "claim_mismatch", "description", "a read ability describes a change"),
    );
  if (ability.kind === "write" && READ_VERB.test(claim))
    out.push(
      finding("error", "claim_mismatch", "description", "a write ability describes only reading"),
    );
}

const INPUT_REF =
  /\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}|\binputs\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g;

function referencedInputs(ability: Ability): string[] {
  const text = JSON.stringify(ability.ways);
  const names = new Set<string>();
  for (const match of text.matchAll(INPUT_REF))
    for (const name of match.slice(1)) if (name) names.add(name);
  return [...names];
}

function schemaProperties(schema: unknown): Record<string, Record<string, unknown>> {
  const value = schema as { properties?: Record<string, Record<string, unknown>> } | undefined;
  if (value?.properties && typeof value.properties === "object") return value.properties;
  if (schema && typeof schema === "object" && !("type" in schema))
    return schema as Record<string, Record<string, unknown>>;
  return {};
}

function requiredNames(schema: unknown): string[] {
  const required = (schema as { required?: unknown } | undefined)?.required;
  return Array.isArray(required) ? required.map(String) : [];
}

function scalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number";
}

function isTemplate(value: unknown): boolean {
  return typeof value === "string" && /\{\{.*\}\}/.test(value);
}

function dedupe(findings: PublishFinding[]): PublishFinding[] {
  const seen = new Map<string, PublishFinding>();
  for (const finding of findings) seen.set(`${finding.code}:${finding.path}`, finding);
  return [...seen.values()];
}
