import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aeonDataDirectory } from "@aeon/location";

// Per-client revocable tokens for `aeon mcp --http` and `aeon rest`. Only a SHA-256 of each token
// is kept, in a 0600 file in Aeon's data directory; the token itself is printed once at creation.

export const TOKEN_PREFIX = "aeon_mcp_";

export interface TokenRecord {
  name: string;
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
}

function tokensPath(directory = aeonDataDirectory()): string {
  return join(directory, "mcp-tokens.json");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function readTokens(directory?: string): Promise<TokenRecord[]> {
  try {
    const saved = JSON.parse(await readFile(tokensPath(directory), "utf8")) as unknown;
    return Array.isArray(saved) ? (saved as TokenRecord[]) : [];
  } catch {
    return [];
  }
}

async function writeTokens(records: TokenRecord[], directory?: string): Promise<void> {
  const path = tokensPath(directory);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, JSON.stringify(records, null, 2), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  await chmod(path, 0o600);
}

/** A new token for one client; the same name replaces that client's old token. */
export async function createToken(name: string, directory?: string): Promise<string> {
  const label = name.trim();
  if (!/^[\w.-]{1,64}$/.test(label))
    throw new Error("A token name is 1-64 letters, digits, dots, dashes or underscores.");
  const token = TOKEN_PREFIX + randomBytes(24).toString("base64url");
  const records = (await readTokens(directory)).filter((record) => record.name !== label);
  records.push({ name: label, hash: hashToken(token), createdAt: new Date().toISOString() });
  await writeTokens(records, directory);
  return token;
}

export async function revokeToken(name: string, directory?: string): Promise<boolean> {
  const records = await readTokens(directory);
  const kept = records.filter((record) => record.name !== name);
  if (kept.length === records.length) return false;
  await writeTokens(kept, directory);
  return true;
}

/** The client a token belongs to, or undefined. Compared in constant time. */
export async function verifyToken(token: string, directory?: string): Promise<string | undefined> {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const given = Buffer.from(hashToken(token), "hex");
  for (const record of await readTokens(directory)) {
    const expected = Buffer.from(record.hash, "hex");
    if (expected.length === given.length && timingSafeEqual(expected, given)) return record.name;
  }
  return undefined;
}

/** The token a request carries: `Authorization: Bearer …` or `x-aeon-token`. */
export function requestToken(headers: Record<string, string | string[] | undefined>): string {
  const bearer = /^Bearer\s+(\S+)$/i.exec(String(headers.authorization ?? ""))?.[1];
  return String(bearer ?? headers["x-aeon-token"] ?? "");
}
