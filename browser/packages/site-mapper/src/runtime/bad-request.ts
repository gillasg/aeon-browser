// A 400 from a site usually says which input it did not like, in whatever shape that site uses.
// Pull those names out, set them beside what the operation declares and what the caller passed,
// so the next call can fix the right thing instead of guessing from a generic "HTTP 400".

import { inputParams } from "../params.js";
import type { Operation } from "../types.js";
import type { Params, RuntimeResponse } from "./request.js";

const NAME = /^[A-Za-z_][\w.\-[\]]{0,63}$/;
const FIELD_KEYS = ["field", "param", "parameter", "name", "loc", "path", "pointer", "key"];
const LIST_KEYS = [
  "errors",
  "violations",
  "detail",
  "details",
  "fieldErrors",
  "invalidParams",
  "issues",
];
const MAP_KEYS = ["errors", "fieldErrors", "fields", "validation", "validationErrors", "details"];
const MESSAGE_KEYS = ["message", "msg", "error", "detail", "description", "title"];
const QUOTED = /['"`]([A-Za-z_][\w.\-[\]]{0,63})['"`]/g;
const NAMED_REQUIRED =
  /\b([A-Za-z_][\w.-]{0,63})\b (?:is|are) (?:required|missing|invalid|not valid|too (?:short|long))/gi;
const MISSING_LIST =
  /\b(?:missing|required|invalid|unknown|unexpected)(?: (?:required|query|path|body|header))? (?:parameters?|params?|fields?|arguments?|inputs?)[:\s]+([A-Za-z_][\w.\-, ]{0,120})/gi;
const NOT_NAMES = new Set(["error", "errors", "message", "status", "code", "request", "body"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nameFrom(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value.at(-1) : value;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const name = String(raw);
  return NAME.test(name) && !NOT_NAMES.has(name) ? name : undefined;
}

function fieldOf(item: Record<string, unknown>): string | undefined {
  for (const key of FIELD_KEYS) {
    const name = nameFrom(item[key]);
    if (name) return name;
  }
  return undefined;
}

function fromList(list: unknown, found: Set<string>): void {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (isRecord(item)) {
      const name = fieldOf(item);
      if (name) found.add(name);
      fromStructure(item, found);
    } else if (typeof item === "string") fromMessage(item, found);
  }
}

function fromMap(map: unknown, found: Set<string>): void {
  if (!isRecord(map)) return;
  for (const name of Object.keys(map)) if (NAME.test(name) && !NOT_NAMES.has(name)) found.add(name);
}

function fromStructure(value: unknown, found: Set<string>): void {
  if (!isRecord(value)) return;
  for (const key of LIST_KEYS) fromList(value[key], found);
  for (const key of MAP_KEYS) fromMap(value[key], found);
  const nested = value.error ?? value.data;
  if (isRecord(nested)) fromStructure(nested, found);
}

function fromMessage(text: string, found: Set<string>): void {
  for (const match of text.matchAll(QUOTED)) if (match[1]) found.add(match[1]);
  for (const match of text.matchAll(NAMED_REQUIRED)) if (match[1]) found.add(match[1]);
  for (const match of text.matchAll(MISSING_LIST))
    for (const name of (match[1] ?? "").split(/[,\s]+(?:and\s+)?/))
      if (NAME.test(name) && !NOT_NAMES.has(name.toLowerCase())) found.add(name);
}

function messagesOf(json: unknown): string[] {
  if (typeof json === "string") return [json];
  if (!isRecord(json)) return [];
  const own = MESSAGE_KEYS.map((key) => json[key]).filter(
    (value): value is string => typeof value === "string",
  );
  const nested = isRecord(json.error) ? messagesOf(json.error) : [];
  return [...own, ...nested];
}

/** Input names a 400/422 body points at, in the order it names them. */
export function invalidInputNames(response: RuntimeResponse): string[] {
  const found = new Set<string>();
  fromStructure(response.json, found);
  for (const message of [...messagesOf(response.json), response.text ?? ""]) {
    fromMessage(message.slice(0, 2000), found);
  }
  return [...found].slice(0, 12);
}

/** The operation's inputs as a caller passes them: `q (query, required)`. */
export function declaredInputs(operation: Operation): string[] {
  if (!Array.isArray(operation.params)) return [];
  return inputParams(operation).map(
    (param) => `${param.name} (${param.in}${param.required ? ", required" : ""})`,
  );
}

/** Input names in the shape a caller passes them, for the "missing" half of an error. */
export function plainInputName(target: string): string {
  const colon = target.indexOf(":");
  return colon > 0 && /^(path|query|header|body|cookie)$/.test(target.slice(0, colon))
    ? target.slice(colon + 1)
    : target;
}

/** The full explanation of a 400: what the site flagged, what is declared, what was passed. */
export function badRequestDetail(
  operation: Operation | undefined,
  params: Params,
  response: RuntimeResponse,
): string {
  const named = invalidInputNames(response);
  const parts: string[] = [];
  const declared = operation ? inputNames(operation) : [];
  const flagged = named.filter((name) => declared.includes(name) || !declared.length);
  if (named.length)
    parts.push(
      `The site flagged: ${named.join(", ")}${flagged.length < named.length ? " (not all are declared inputs)" : ""}.`,
    );
  else parts.push("The site did not name the input it rejected.");
  if (operation)
    parts.push(
      `${operation.id} declares: ${declaredInputs(operation).join(", ") || "no inputs"}.`,
      `Passed: ${passed(params)}.`,
      `Required inputs missing from this call: ${missingRequired(operation, params).join(", ") || "none"}.`,
    );
  parts.push("Next: pass the named inputs with valid values and call again.");
  return parts.join(" ");
}

function passed(params: Params): string {
  const names = Object.keys(params).filter((key) => !key.startsWith("$"));
  return names.length ? names.join(", ") : "nothing";
}

function inputNames(operation: Operation): string[] {
  return Array.isArray(operation.params) ? inputParams(operation).map((param) => param.name) : [];
}

function missingRequired(operation: Operation, params: Params): string[] {
  if (!Array.isArray(operation.params)) return [];
  return inputParams(operation)
    .filter((param) => param.required && params[param.name] === undefined)
    .map((param) => param.name);
}
