/**
 * Credential references stored in capabilities.json. They name where a secret lives, never the
 * secret itself:
 * - `env:<VAR>`: an HTTP server gets `Authorization: Bearer <value>`; a stdio server gets `VAR`.
 * - `header:<Name>=env:<VAR>`: an HTTP server gets `<Name>: <value>`; a stdio server gets `VAR`.
 *   Several header references may be joined with commas.
 * - `external-config-only` / `external:<id>`: bound outside Aeon; nothing is resolved here.
 */
export interface CredentialBinding {
  /** The header to send, or undefined for the bearer form. */
  header?: string;
  env: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** RFC 9110 token characters: no spaces, CR, LF, colons or other control characters. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const MAX_HEADERS = 8;

export function isExternalReference(reference: string): boolean {
  return (
    reference === "external-config-only" || /^external:[A-Za-z0-9._:-]{1,120}$/.test(reference)
  );
}

/** The env-backed bindings in a reference; [] for none or external ones. Throws when malformed. */
export function parseCredentialBindings(reference: string | null | undefined): CredentialBinding[] {
  if (!reference || isExternalReference(reference)) return [];
  if (reference.startsWith("env:")) {
    const env = reference.slice(4);
    if (!ENV_NAME.test(env)) throw invalid("the environment variable name is not valid");
    return [{ env }];
  }
  const parts = reference.split(",");
  if (parts.length > MAX_HEADERS) throw invalid(`at most ${MAX_HEADERS} header references`);
  const seen = new Set<string>();
  return parts.map((part) => {
    const match = /^header:([^=]*)=env:(.*)$/s.exec(part);
    if (!match) throw invalid("use env:<VAR> or header:<Name>=env:<VAR>");
    const [, header = "", env = ""] = match;
    if (!HEADER_NAME.test(header))
      throw invalid(`header name '${printable(header)}' contains characters a header cannot hold`);
    if (!ENV_NAME.test(env))
      throw invalid(`'${printable(env)}' is not an environment variable name`);
    const key = header.toLowerCase();
    if (seen.has(key)) throw invalid(`header '${header}' is given twice`);
    seen.add(key);
    return { header, env };
  });
}

export function isValidCredentialReference(reference: string): boolean {
  if (isExternalReference(reference)) return true;
  try {
    return parseCredentialBindings(reference).length > 0;
  } catch {
    return false;
  }
}

export interface ResolvedCredentials {
  /** Environment variables for a stdio server. */
  env: Record<string, string>;
  /** Request headers for an HTTP server. */
  headers: Record<string, string>;
}

/** Reads each referenced variable now; a missing or unsafe value fails with its name, never its value. */
export function resolveCredentials(
  reference: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedCredentials {
  const resolved: ResolvedCredentials = { env: {}, headers: {} };
  for (const binding of parseCredentialBindings(reference)) {
    const value = environment[binding.env];
    if (!value)
      throw new Error(
        `MCP_CREDENTIAL_MISSING: environment variable ${binding.env} is not set for this MCP server.`,
      );
    if (/[\r\n\0]/.test(value))
      throw new Error(
        `MCP_CREDENTIAL_INVALID: environment variable ${binding.env} holds a line break or NUL.`,
      );
    resolved.env[binding.env] = value;
    if (binding.header) resolved.headers[binding.header] = value;
    else resolved.headers.Authorization = `Bearer ${value}`;
  }
  return resolved;
}

function invalid(reason: string): Error {
  return new Error(`MCP_CREDENTIAL_INVALID: credentialReference is malformed: ${reason}.`);
}

function printable(text: string): string {
  return JSON.stringify(text).slice(1, -1).slice(0, 80);
}
