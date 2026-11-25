import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { aeonDataDirectory } from "@aeon/location";

// `aeon mcp add|list|remove`: one-line registration of an inbound MCP server into Aeon's
// capability registry (capabilities.json in the data directory). The daemon reads that file on
// every listing, so a server added here is callable at once from browser_code as
// mcp.<name>.<tool>(args) and found by mcp.search(query). Only references to secrets are stored.

export const MCP_SERVERS_HELP = `Usage: aeon mcp add <name> -- <command> [args...]
       aeon mcp add <name> --url <url> [--header <Name>=env:<VAR>]... [--bearer-env <VAR>]
       aeon mcp list [--json]
       aeon mcp remove <name>

  add       register a stdio server (after --) or a Streamable HTTP server (--url)
  --header  send <Name> with the value of environment variable <VAR> (repeatable)
  --bearer-env  send Authorization: Bearer <value of VAR>; for stdio, pass VAR to the server
  --description  what the server is for (helps mcp.search)
  list      show registered MCP servers
  remove    remove one by name or capability id

Secrets are never stored: only the variable names. Tools appear as mcp.<name>.<tool>(args).`;

const SCHEMA_VERSION = 1;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const SECRET_OPTION = /^--?(?:token|secret|password|api[-_]?key)(?:=|$)/i;

type Json = Record<string, unknown>;
interface Registry {
  schemaVersion: number;
  revision: number;
  capabilities: Json[];
}

export interface McpAddRequest {
  name: string;
  command?: string;
  args: string[];
  url?: string;
  headers: string[];
  bearerEnv?: string;
  description?: string;
}

/** Parses the words after `aeon mcp add`; everything after `--` is the server's command line. */
export function parseMcpAdd(argv: string[]): McpAddRequest {
  const dash = argv.indexOf("--");
  const own = dash < 0 ? argv : argv.slice(0, dash);
  const command = dash < 0 ? [] : argv.slice(dash + 1);
  const request: McpAddRequest = { name: "", args: [], headers: [] };
  for (let index = 0; index < own.length; index += 1) {
    const word = own[index] ?? "";
    const [flagName, inline] = word.startsWith("--") ? splitFlag(word) : [undefined, undefined];
    if (!flagName) {
      if (request.name) throw new Error(`unexpected '${word}'; put the server command after --`);
      request.name = word;
      continue;
    }
    const value = inline ?? own[++index];
    if (value === undefined) throw new Error(`--${flagName} needs a value`);
    applyFlag(request, flagName, value);
  }
  return finishAdd(request, command);
}

function finishAdd(request: McpAddRequest, command: string[]): McpAddRequest {
  if (!request.name) throw new Error("a server name is required: aeon mcp add <name> ...");
  if (command.length) [request.command, ...request.args] = command as [string, ...string[]];
  if (!request.command === !request.url)
    throw new Error("give either -- <command> [args...] (stdio) or --url <url> (HTTP)");
  return request;
}

function applyFlag(request: McpAddRequest, name: string, value: string): void {
  if (name === "url") request.url = value;
  else if (name === "header") request.headers.push(value);
  else if (name === "bearer-env") request.bearerEnv = value;
  else if (name === "description") request.description = value;
  else throw new Error(`unknown option --${name}`);
}

function splitFlag(word: string): [string, string | undefined] {
  const body = word.slice(2);
  const at = body.indexOf("=");
  return at < 0 ? [body, undefined] : [body.slice(0, at), body.slice(at + 1)];
}

export function capabilityId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 58);
  if (!slug) throw new Error(`'${name}' has no letters or digits to name the server by`);
  return `cap_${slug}`;
}

/** Builds the credential reference: `env:VAR` for a bearer token, `header:Name=env:VAR` per header. */
export function credentialReference(request: McpAddRequest): string | null {
  if (request.bearerEnv && request.headers.length)
    throw new Error("use either --bearer-env or --header, not both");
  if (request.bearerEnv) {
    if (!ENV_NAME.test(request.bearerEnv))
      throw new Error(`'${request.bearerEnv}' is not a variable name`);
    return `env:${request.bearerEnv}`;
  }
  if (!request.headers.length) return null;
  const parts = request.headers.map((header) => {
    const match = /^([^=]*)=env:(.*)$/s.exec(header);
    if (!match) throw new Error(`--header must look like <Name>=env:<VAR>, got '${header}'`);
    const [, name = "", variable = ""] = match;
    if (!HEADER_NAME.test(name))
      throw new Error(`'${JSON.stringify(name)}' is not a valid header name`);
    if (!ENV_NAME.test(variable)) throw new Error(`'${variable}' is not a variable name`);
    return `header:${name}=env:${variable}`;
  });
  if (parts.length > 8) throw new Error("at most 8 --header options");
  return parts.join(",");
}

export function buildCapability(request: McpAddRequest, cwd: string): Json {
  const credential = credentialReference(request);
  if (request.args.some((arg) => SECRET_OPTION.test(arg)))
    throw new Error("server arguments cannot carry secrets; use --bearer-env or an env variable");
  if (request.url) checkUrl(request.url);
  return {
    id: capabilityId(request.name),
    kind: "mcp",
    displayName: request.name.slice(0, 120),
    description: (request.description ?? `MCP server ${request.name}`).slice(0, 1000),
    configReference: "aeon mcp add",
    credentialReference: credential,
    relatedSkillIds: [],
    verification: { state: "needs_check", checkedAt: null, summary: null },
    transport: request.url ? "streamable-http" : "stdio",
    command: request.command ?? null,
    args: request.url ? [] : request.args,
    endpoint: request.url ?? null,
    workingDirectory: request.url ? null : cwd,
  };
}

function checkUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`'${value}' is not a URL`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("--url must be an http(s) URL without credentials or a fragment");
  if (
    [...url.searchParams.keys()].some((key) => /token|secret|password|api[-_]?key|auth/i.test(key))
  )
    throw new Error("--url query parameters cannot carry credentials; use --header");
}

export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(aeonDataDirectory({ env }), "capabilities.json");
}

async function readRegistry(path: string): Promise<Registry> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Registry;
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.capabilities))
      throw new Error(`${path} has an unsupported schema`);
    return parsed;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT")
      return { schemaVersion: SCHEMA_VERSION, revision: 0, capabilities: [] };
    throw error;
  }
}

async function writeRegistry(path: string, registry: Registry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function sameServer(item: Json, name: string): boolean {
  if (item.kind !== "mcp") return false;
  return item.id === name || item.displayName === name || item.id === safeId(name);
}

function safeId(name: string): string | undefined {
  try {
    return capabilityId(name);
  } catch {
    return undefined;
  }
}

export async function addMcpServer(
  request: McpAddRequest,
  path: string,
  cwd: string,
): Promise<Json> {
  const capability = buildCapability(request, cwd);
  const registry = await readRegistry(path);
  if (
    registry.capabilities.some(
      (item) => item.id === capability.id || sameServer(item, request.name),
    )
  )
    throw new Error(`an MCP server named '${request.name}' is already registered; remove it first`);
  const capabilities = [...registry.capabilities, capability].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
  await writeRegistry(path, { ...registry, revision: registry.revision + 1, capabilities });
  return capability;
}

export async function removeMcpServer(name: string, path: string): Promise<boolean> {
  const registry = await readRegistry(path);
  const capabilities = registry.capabilities.filter((item) => !sameServer(item, name));
  if (capabilities.length === registry.capabilities.length) return false;
  await writeRegistry(path, { ...registry, revision: registry.revision + 1, capabilities });
  return true;
}

export async function listMcpServers(path: string): Promise<Json[]> {
  return (await readRegistry(path)).capabilities.filter((item) => item.kind === "mcp");
}

function describe(item: Json): string {
  const target =
    item.transport === "stdio"
      ? [item.command, ...((item.args as string[]) ?? [])].join(" ")
      : String(item.endpoint);
  const auth = item.credentialReference ? ` (auth: ${String(item.credentialReference)})` : "";
  return `${String(item.displayName)}  ${String(item.id)}  ${String(item.transport)}  ${target}${auth}`;
}

/** Runs `aeon mcp add|list|remove`; `argv` is the words after `mcp`. */
export async function mcpServersCommand(
  argv: string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  path = registryPath(),
  cwd = process.cwd(),
): Promise<number> {
  const [action, ...rest] = argv;
  if (action === "add") {
    const capability = await addMcpServer(parseMcpAdd(rest), path, cwd);
    write(
      `Added ${String(capability.displayName)} as ${String(capability.id)}. Use it in browser_code as mcp.search('...') or mcp.<name>.<tool>(args).`,
    );
    return 0;
  }
  if (action === "remove") {
    const name = rest[0];
    if (!name) throw new Error("usage: aeon mcp remove <name>");
    if (!(await removeMcpServer(name, path))) {
      write(`No MCP server named '${name}'.`);
      return 1;
    }
    write(`Removed ${name}.`);
    return 0;
  }
  const servers = await listMcpServers(path);
  if (rest.includes("--json")) write(JSON.stringify(servers, null, 2));
  else if (!servers.length)
    write("No MCP servers registered. Add one with aeon mcp add <name> -- <command>.");
  else for (const item of servers) write(describe(item));
  return 0;
}

export const MCP_SERVER_ACTIONS = new Set(["add", "list", "remove"]);
