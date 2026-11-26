import type { Param } from "../types.js";
import type { Member } from "./operations.js";

// A persisted GraphQL query sent as a path segment (/api/v3/AutoSuggestionsQuery/<sha256>) is
// part of the endpoint, never something a caller knows: it is replayed as a constant and the
// bundle heal rotates it when the site ships a new hash.

export const PERSISTED_HASH = /^(?:[0-9a-f]{32,}|[A-Za-z0-9_-]{43,}={0,2})$/i;

function operationNames(member: Member): Set<string> {
  const names = new Set<string>();
  if (member.graphql?.operationName) names.add(member.graphql.operationName);
  const query = new URL(member.exchange.url).searchParams.get("operationName");
  if (query) names.add(query);
  return names;
}

/** True when the path segment at `index` is a hash right before or after the operation name. */
export function nextToOperationName(member: Member, index: number): boolean {
  const parts = new URL(member.exchange.url).pathname.split("/").filter(Boolean);
  const value = parts[index];
  if (!value || !PERSISTED_HASH.test(value)) return false;
  const names = operationNames(member);
  return names.has(parts[index - 1] ?? "") || names.has(parts[index + 1] ?? "");
}

/** Turns a path param holding a persisted-query hash into a recorded constant. */
export function markPersistedHash(param: Param, template: string, members: Member[]): void {
  const index = template.split("/").filter(Boolean).indexOf(`{${param.name}}`);
  const first = members[0];
  if (index < 0 || !first || !nextToOperationName(first, index)) return;
  const value = first.pathValues[param.name];
  if (!value) return;
  param.constant = value;
  param.required = false;
  param.persistedHash = true;
}
