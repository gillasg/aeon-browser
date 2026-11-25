import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { flag, has, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
import {
  generateStandaloneClient,
  loadFlows,
  loadModel,
  rebuild,
  serve,
  siteName,
} from "@browserkit/tools/site-to-api";
import { runMcpServer, startMcpServer, type McpSurface } from "./mcp.js";
import { serveMcpHttp } from "./mcp-http.js";
import { MCP_SERVER_ACTIONS, MCP_SERVERS_HELP, mcpServersCommand } from "./mcp-servers-cmd.js";
import { createToken, readTokens, revokeToken, verifyToken } from "./mcp-tokens.js";

// `aeon mcp` (stdio or Streamable HTTP, code or full surface), its per-client tokens,
// `aeon rest` (the local REST server, on the same tokens) and `aeon compile`.

const out = (line: string) => process.stdout.write(`${line}\n`);

function surfaceOf(args: Args): McpSurface {
  const value = flag(args, "surface") ?? "code";
  if (value !== "code" && value !== "full") throw new Error("--surface is code or full");
  return value;
}

async function tokenCommand(args: Args): Promise<number> {
  const [, action, positionalName] = args.positional;
  const name = flag(args, "name") ?? positionalName;
  if (action === "create") {
    if (!name) throw new Error("Usage: aeon mcp token create --name <client>");
    out(await createToken(name));
    process.stderr.write(`Token for ${name}. It is shown once; Aeon keeps only its hash.\n`);
    return 0;
  }
  if (action === "list") {
    const tokens = await readTokens();
    if (has(args, "json"))
      out(
        JSON.stringify(
          tokens.map(({ name, createdAt }) => ({ name, createdAt })),
          null,
          2,
        ),
      );
    else if (!tokens.length) out("No tokens. Create one: aeon mcp token create --name <client>");
    else for (const token of tokens) out(`${token.name}\t${token.createdAt}`);
    return 0;
  }
  if (action === "revoke") {
    if (!name) throw new Error("Usage: aeon mcp token revoke --name <client>");
    const revoked = await revokeToken(name);
    out(revoked ? `Revoked ${name}.` : `No token named ${name}.`);
    return revoked ? 0 : 1;
  }
  throw new Error("Usage: aeon mcp token create|list|revoke [--name <client>]");
}

async function mcpCommand(args: Args): Promise<number> {
  if (args.positional[0] === "token") return tokenCommand(args);
  // The raw words keep `-- <command> --its-flags` and repeated --header intact.
  if (MCP_SERVER_ACTIONS.has(args.positional[0] ?? "")) {
    const argv = process.argv.slice(2);
    return mcpServersCommand(argv.slice(argv.indexOf("mcp") + 1));
  }
  const surface = surfaceOf(args);
  if (!has(args, "http")) {
    await runMcpServer(flag(args, "site") ?? args.positional[0], { surface });
    return 0;
  }
  let broadcast: (message: Record<string, unknown>) => void = () => undefined;
  const session = await startMcpServer({ surface }, (message) => broadcast(message));
  const server = await serveMcpHttp({
    port: Number(flag(args, "port") ?? 4790),
    receive: (message, send) => session.receive(message, send),
  });
  broadcast = server.broadcast;
  const tokens = await readTokens();
  out(`MCP (Streamable HTTP) at ${server.url}`);
  out(
    tokens.length
      ? `Clients send Authorization: Bearer <token>; tokens: ${tokens.map((token) => token.name).join(", ")}`
      : "No client tokens yet. Create one: aeon mcp token create --name <client>",
  );
  await waitForSignal();
  await server.close();
  session.close();
  return 0;
}

async function restCommand(args: Args): Promise<number> {
  const port = flag(args, "port");
  const only = args.positional[0];
  const server = await serve({
    ...(port ? { port: Number(port) } : {}),
    ...(only ? { site: siteName(only) } : {}),
    authorize: async (token) => (await verifyToken(token)) !== undefined,
  });
  out(
    only
      ? `Serving ${siteName(only)} at ${server.url}/sites/${encodeURIComponent(siteName(only))}/docs`
      : `Serving every mapped site at ${server.url}/#token=${server.token}`,
  );
  out(`Calls need the header x-site-to-api-token: ${server.token}`);
  out("Or Authorization: Bearer <token> with a client token from aeon mcp token create.");
  await waitForSignal();
  await server.close();
  return 0;
}

/** Learn (when not mapped yet) → model-free build → a standalone typed client in the repo. */
async function compileCommand(args: Args, map: Command | undefined): Promise<number> {
  const input = args.positional[0];
  if (!input) throw new Error("Usage: aeon compile <url|site> [--out src/gen]");
  const site = siteName(input);
  let model = await loadModel(site);
  if (!model && !(await loadFlows(site)).exchanges.length) {
    if (!map) throw new Error(`${site} is not mapped. Map it first: aeon map ${input}`);
    process.stderr.write(`Learning ${site}: use the page, recording stops when it goes quiet.\n`);
    const url = /^https?:\/\//.test(input) ? input : `https://${input}`;
    const code = await map.run({
      positional: [url],
      flags: { "until-idle": flag(args, "until-idle") ?? "15", "no-build": true },
    });
    if (code !== 0) return code;
  }
  if (!model || has(args, "rebuild")) model = (await rebuild(site)).model;
  const client = generateStandaloneClient(model);
  const dir = resolve(flag(args, "out") ?? join("src", "gen"));
  const base = site.replace(/[^\w.-]/g, "_");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${base}.ts`), client.source);
  await writeFile(join(dir, `${base}.d.ts`), client.declarations);
  process.stderr.write(
    `Wrote ${join(dir, `${base}.ts`)} and ${base}.d.ts (${model.operations.length} operations). ` +
      "It calls aeon rest with AEON_TOKEN from aeon mcp token create.\n",
  );
  out(
    client.firstRead
      ? `aeon call ${site} ${client.firstRead} '{}'`
      : `aeon_find {"ref":"site:${site}"}`,
  );
  return 0;
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

export function mcpCommands(map: Command | undefined): Command[] {
  return [
    {
      name: "mcp",
      group: "Browser",
      summary:
        "MCP server (stdio or HTTP), or add/list/remove the MCP servers Aeon's chats can call",
      help: `Usage: aeon mcp [site] [--surface code|full]
       aeon mcp --http [--port 4790] [--surface code|full]
       aeon mcp token create|list|revoke --name <client>

Without a site: Aeon for another agent. The default surface is five fixed tools (browser_code,
aeon_find, aeon_call, aeon_resume, aeon_run); --surface full lists every tool, one per mapped
operation too. With a site: that site's operations as MCP tools. --http serves Streamable HTTP
on 127.0.0.1 only; each client sends its own revocable token as Authorization: Bearer.

${MCP_SERVERS_HELP}`,
      run: mcpCommand,
    },
    {
      name: "rest",
      group: "Browser",
      summary: "local REST API for every mapped site, on 127.0.0.1, with client tokens",
      help: `Usage: aeon rest [site] [--port <n>]

POST /sites/<site>/ops/<operationId> calls an operation as the user. Calls need the token it
prints (header x-site-to-api-token) or a client token from aeon mcp token create (Authorization:
Bearer). Clients from aeon compile call http://127.0.0.1:4791 by default: aeon rest --port 4791.`,
      run: restCommand,
    },
    {
      name: "compile",
      group: "Browser",
      summary: "turn a site into a zero-dependency typed client in your repo",
      help: `Usage: aeon compile <url|site> [--out src/gen] [--rebuild] [--until-idle <s>]

Learns the site when it is not mapped yet (you use the page while Aeon records), builds it
with no model, and writes <site>.ts and <site>.d.ts: typed methods, async iterators for
paginated operations, and NOT_PROVEN for writes the page has not proven. The client calls
aeon rest (--port 4791, or AEON_REST_URL) with AEON_TOKEN. Prints one runnable next line.`,
      run: (args) => compileCommand(args, map),
    },
  ];
}
