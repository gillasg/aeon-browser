import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { COMMANDS as BROWSERKIT_COMMANDS } from "browserkit/dist/commands/index.js";
import { flag, has, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
import { blockedCommands } from "./blocked.js";
import { browserCommands } from "./browser-commands.js";
import { providerCommands } from "./provider-commands.js";
import { dataDirectory } from "./client.js";
import type { DaemonHost } from "./host.js";
import { install } from "./install.js";
import { runMcpServer } from "./mcp.js";
import { inspect, runTasks, type RunOptions } from "./run.js";
import { nextDay, searchAeon } from "./search.js";
import type { ChatResult } from "./results.js";
import { settingsCommand } from "./settings.js";
import { signinCommand } from "./signin.js";
import { setupCommands } from "./setup.js";
import { packCommand } from "./pack.js";
import { listTools, runTool } from "./tools.js";

// Every command Aeon has: its own chat commands, then browserkit's commands in the same groups,
// with the few that are about a bridge or a password-manager folder replaced by Aeon's own.

async function run(host: DaemonHost, args: Args): Promise<number> {
  const prompts = await readPrompts(args);
  if (!prompts.length) throw new Error('Usage: aeon run "<task>" or aeon run --file tasks.txt');
  const options = runOptions(args);
  const client = await host.connect();
  process.stderr.write(
    `Running ${prompts.length} task(s), ${options.parallel} at a time` +
      (options.quiet ? ".\n" : "; each opens as a background tab in Chrome.\n"),
  );
  const results = await runTasks(client, prompts, {
    ...options,
    origin: "cli",
    onProgress: (line) => process.stderr.write(line + "\n"),
  });
  const report = await saveReport(results);
  if (has(args, "json")) process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  else for (const result of results) process.stdout.write(formatResult(result) + "\n");
  process.stderr.write(`Report: ${report}\n`);
  return results.every((result) => result.status === "finished") ? 0 : 1;
}

function runOptions(args: Args): Omit<RunOptions, "origin" | "onProgress" | "onStarted"> {
  const model = flag(args, "model");
  const [provider, ...id] = (model ?? "").split("/");
  const thinking = flag(args, "thinking");
  return {
    parallel: Math.max(1, Math.min(20, Number(flag(args, "parallel") ?? 5))),
    quiet: has(args, "quiet"),
    ...(model && provider && id.length ? { model: { provider, id: id.join("/") } } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {}),
    timeoutMs: Number(flag(args, "timeout") ?? 20) * 60_000,
  };
}

async function readPrompts(args: Args): Promise<string[]> {
  const file = flag(args, "file");
  if (!file) return args.positional;
  const text = await readFile(file, "utf8");
  if (file.endsWith(".json")) {
    const parsed = JSON.parse(text) as (string | { prompt: string })[];
    return [
      ...args.positional,
      ...parsed.map((item) => (typeof item === "string" ? item : item.prompt)),
    ];
  }
  return [
    ...args.positional,
    ...text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ];
}

async function saveReport(results: ChatResult[]): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const folder = join(dataDirectory(), "cli-runs");
  await mkdir(folder, { recursive: true });
  const path = join(folder, new Date().toISOString().replace(/[:.]/g, "-") + ".json");
  await writeFile(path, JSON.stringify(results, null, 2));
  return path;
}

function formatResult(result: ChatResult): string {
  return [
    `── ${result.status.toUpperCase()} · ${Math.round(result.seconds)}s · ${result.toolCalls} tool calls` +
      ` (${result.toolErrors} errors) · ${result.tabsOpened} tabs · chat ${result.chatId}`,
    `Task: ${result.prompt}`,
    result.answer || "(no answer)",
  ].join("\n");
}

function formatTrace(result: ChatResult): string {
  const steps = result.trace
    .map(
      (step, index) =>
        `${index + 1}. ${step.tool}${step.error ? " [ERROR]" : ""} ${step.at}\n${step.summary}`,
    )
    .join("\n\n");
  return [steps, cacheLine(result)].filter(Boolean).join("\n\n");
}

/** "Prompt cache: 94% of prompt tokens over 12 turns; fell on turn 5, 9", for reviews. */
function cacheLine(result: ChatResult): string {
  const cache = result.cache;
  if (!cache) return "";
  const fell = cache.misses.length ? `; fell on turn ${cache.misses.join(", ")}` : "";
  return `Prompt cache: ${Math.round(cache.hitRate * 100)}% of prompt tokens over ${cache.turns} turns${fell}`;
}

const CHAT_ORIGINS = new Set(["user", "cli", "mcp", "companion", "agent", "routine", "unknown"]);

interface ChatFilter {
  origin?: string;
  since?: string;
  until?: string;
}

async function listChats(host: DaemonHost, args: Args): Promise<number> {
  const limit = Math.min(100, Number(flag(args, "limit") ?? 20));
  const filter = chatFilter(args);
  const client = await host.connect();
  if (has(args, "unreviewed"))
    return printChats(
      await client.tool({
        kind: "core.tool.call",
        tool: "chat_review",
        session: "cli",
        arguments: { action: "list", limit, ...filter },
      }),
      has(args, "json"),
    );
  return printChats(
    await client.command("chat.list", {
      limit,
      ...(filter.origin ? { origin: filter.origin } : {}),
      ...(filter.since ? { since: `${filter.since}T00:00:00.000Z` } : {}),
      ...(filter.until ? { until: nextDay(filter.until) } : {}),
    }),
    has(args, "json"),
  );
}

function chatFilter(args: Args): ChatFilter {
  const origin = flag(args, "from");
  if (origin && !CHAT_ORIGINS.has(origin))
    throw new Error(`--from must be one of ${[...CHAT_ORIGINS].join(", ")}`);
  const since = dayValue(args, "since");
  const until = dayValue(args, "until");
  return {
    ...(origin ? { origin } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  };
}

function dayValue(args: Args, name: string): string | undefined {
  const value = flag(args, name);
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    throw new Error(`--${name} must be YYYY-MM-DD`);
  return value;
}

/** Prints a chat.list result or a chat_review list result, with each chat's origin. */
function printChats(result: unknown, json: boolean): number {
  const value = result as {
    chats?: unknown;
    content?: { text?: string }[];
    isError?: boolean;
  };
  let chats: { chatId: string; title: string; origin?: string }[];
  if (Array.isArray(value.chats)) chats = value.chats as typeof chats;
  else {
    const text = (value.content ?? []).map((part) => part.text ?? "").join("");
    if (value.isError) {
      process.stderr.write(text + "\n");
      return 1;
    }
    chats = JSON.parse(text || "[]") as typeof chats;
  }
  if (json) {
    process.stdout.write(JSON.stringify(chats, null, 2) + "\n");
    return 0;
  }
  for (const chat of chats)
    process.stdout.write(`${chat.chatId}  ${chat.origin ?? "unknown"}  ${chat.title}\n`);
  return 0;
}

async function searchChats(host: DaemonHost, args: Args): Promise<number> {
  const text = args.positional.join(" ").trim();
  if (!text)
    throw new Error(
      'Usage: aeon search "<text>" [--from origin] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]',
    );
  const result = await searchAeon(
    await host.connect(),
    text,
    chatFilter(args),
    Math.min(100, Number(flag(args, "limit") ?? 20)),
  );
  if (has(args, "json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  if (!result.chats.length && !result.pins.length) {
    process.stdout.write("No chats or saved answers match.\n");
    return 0;
  }
  for (const chat of result.chats)
    process.stdout.write(
      `${chat.chatId}  ${chat.origin ?? "unknown"}  ${chat.title}${chat.matchExcerpt ? `  — ${chat.matchExcerpt}` : ""}\n`,
    );
  for (const pin of result.pins)
    process.stdout.write(`pin  ${pin.pinId}  ${pin.title}  — ${pin.value}\n`);
  return 0;
}

const ROUTINE_ACTIONS = new Set(["create", "list", "pause", "delete"]);

function routinePayload(args: Args): Record<string, unknown> {
  const action = args.positional[0];
  if (!action || !ROUTINE_ACTIONS.has(action))
    throw new Error(
      'Usage: aeon routine create "<instruction>" [--schedule "every 15 minutes"] [--title t] [--check code] [--sites a,b] | list | pause <id> | delete <id>',
    );
  if (action === "create") return { action, ...routineCreateFields(args) };
  if (action === "list") return { action };
  const routineId = args.positional[1];
  if (!routineId) throw new Error(`Usage: aeon routine ${action} <routineId>`);
  return { action, routineId };
}

function routineCreateFields(args: Args): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    instruction: args.positional.slice(1).join(" ").trim(),
  };
  for (const name of ["title", "schedule", "check"] as const) {
    const value = flag(args, name);
    if (value) fields[name] = value;
  }
  const sites = flag(args, "sites");
  if (sites)
    fields.sites = sites
      .split(",")
      .map((site) => site.trim())
      .filter(Boolean);
  const chat = flag(args, "chat");
  if (chat) fields.chatId = chat;
  return fields;
}

async function routineCommand(host: DaemonHost, args: Args): Promise<number> {
  const value = await callAeonTool(host, "routine", routinePayload(args), "routine");
  if (has(args, "json")) process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  else
    for (const item of Array.isArray(value) ? value : [value])
      process.stdout.write(routineLine(item) + "\n");
  return 0;
}

async function callAeonTool(
  host: DaemonHost,
  tool: string,
  input: Record<string, unknown>,
  label: string,
): Promise<unknown> {
  const client = await host.connect();
  const reply = await client.tool({
    kind: "core.tool.call",
    tool,
    session: "cli",
    arguments: input,
  });
  const text = ((reply.content as { text?: string }[] | undefined) ?? [])
    .map((part) => part.text ?? "")
    .join("");
  if (reply.isError === true) throw new Error(text || `The ${label} command failed.`);
  return JSON.parse(text || "null") as unknown;
}

function routineLine(value: unknown): string {
  const routine = value as {
    routineId?: string;
    title?: string;
    enabled?: boolean;
    nextDueAt?: string | null;
    chatId?: string;
    deleted?: boolean;
  };
  if (routine.deleted) return `Deleted ${routine.routineId}`;
  const state = routine.enabled === false ? "paused" : "active";
  const next = routine.nextDueAt ? ` · next ${routine.nextDueAt}` : "";
  return `${routine.routineId}  ${state}  ${routine.title ?? ""}  (chat ${routine.chatId ?? "?"}${next})`;
}

async function contextCommand(host: DaemonHost, args: Args): Promise<number> {
  const value = (await callAeonTool(host, "context", {}, "context")) as {
    enabled?: boolean;
    tabs?: { title?: string; url?: string; active?: boolean }[];
    hint?: string;
  };
  if (has(args, "json")) {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return 0;
  }
  printContext(value);
  return 0;
}

function printContext(value: {
  enabled?: boolean;
  tabs?: { title?: string; url?: string; active?: boolean }[];
  hint?: string;
}): void {
  if (!value.enabled) {
    process.stdout.write(`${value.hint ?? "Outside agents cannot see the open tabs."}\n`);
    return;
  }
  for (const tab of value.tabs ?? [])
    process.stdout.write(`${tab.active ? "*" : " "} ${tab.title ?? ""}  ${tab.url ?? ""}\n`);
}

async function review(host: DaemonHost, [action, value, note]: string[]): Promise<number> {
  const client = await host.connect();
  const payload: Record<string, unknown> =
    action === "list" ? { action, limit: Number(value) } : { action, chatId: value };
  if (!value) throw new Error("Usage: aeon review <chatId> [note | @file.md]");
  if (action === "mark" && note)
    payload.note = note.startsWith("@") ? await readFile(note.slice(1), "utf8") : note;
  const reply = await client.tool({
    kind: "core.tool.call",
    tool: "chat_review",
    session: "cli",
    arguments: payload,
  });
  const text = ((reply.content as { text?: string }[] | undefined) ?? []).map((c) => c.text ?? "");
  if (action !== "list" || reply.isError === true) {
    process.stdout.write(text.join("\n") + "\n");
    return reply.isError === true ? 1 : 0;
  }
  for (const chat of JSON.parse(text.join("")) as { chatId: string; title: string }[])
    process.stdout.write(`${chat.chatId}  ${chat.title}\n`);
  return 0;
}

/** Automations are routines in the code; `aeon routine` stays as the same command. */
function automationCommand(host: DaemonHost, name: string): Command {
  return {
    name,
    group: "Aeon",
    summary: "create, list, pause or delete automations (routines)",
    help: `Usage: aeon automation create "<instruction>" [--schedule "every 15 minutes"] [--title t]
         [--check "<browser code>"] [--sites a.com,b.com] [--chat <chatId>]
       aeon automation list [--json] | pause <routineId> | delete <routineId>

Creates the automation in a new chat (or --chat, one this CLI created). Alerts go to Aeon only.
\`aeon routine\` is the same command.`,
    run: (args) => routineCommand(host, args),
  };
}

function outsideAgentCommands(host: DaemonHost): Command[] {
  return [
    automationCommand(host, "automation"),
    { ...automationCommand(host, "routine"), hidden: true },
    {
      name: "context",
      group: "Aeon",
      summary: "the user's open tabs, when they allowed it",
      help: `Usage: aeon context [--json]

Returns tab titles and URLs and which is active, only after the user turns on
"Let outside agents see my open tabs" in Aeon Settings. Never page contents.`,
      run: (args) => contextCommand(host, args),
    },
    {
      name: "pack",
      group: "Use sites",
      summary: "export or import a site with its flows, skills and boosts",
      help: `Usage: aeon pack export <site> --out <file.zip> [--no-boosts] [--json]
       aeon pack import <file.zip> [--json]
       aeon pack enable <site> [--json]

A pack holds a mapped site's model, OpenAPI, client and recorded flows, plus the site skills and
boosts written for it. Export strips sessions, cookies and credential-bearing request headers and
bodies. Import writes the site, then saves skills and boosts DISABLED and prints their code; enable
them with "aeon pack enable" after reviewing it.`,
      run: (args) => packCommand(host, args),
    },
  ];
}

function stopCommand(host: DaemonHost): Command {
  return {
    name: "stop",
    group: "Aeon",
    summary: "stop a running chat",
    help: `Usage: aeon stop <chatId>

Stops the chat's current run and closes the agent tabs it no longer needs.`,
    run: async (args) => {
      const chatId = args.positional[0];
      if (!chatId) throw new Error("Usage: aeon stop <chatId>");
      await (await host.connect()).stop(chatId);
      process.stdout.write("Stopped.\n");
      return 0;
    },
  };
}

function aeonOnlyCommands(host: DaemonHost): Command[] {
  return [
    {
      name: "run",
      group: "Aeon",
      summary: "run tasks as Aeon chats",
      help: `Usage: aeon run "<task>" ["<task>" ...] [--file tasks.txt|json] [--parallel 5]
       [--quiet] [--model provider/id] [--thinking level] [--timeout 20] [--json]`,
      run: (args) => run(host, args),
    },
    {
      name: "chats",
      group: "Aeon",
      summary: "recent chats, or the ones not reviewed yet",
      help: `Usage: aeon chats [--limit 20] [--unreviewed] [--from origin] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
       origin: user | cli | mcp | companion | agent | routine | unknown`,
      run: (args) => listChats(host, args),
    },
    {
      name: "search",
      group: "Aeon",
      summary: "search chats and saved answers",
      help: `Usage: aeon search "<text>" [--from origin] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit 20] [--json]
       origin: user | cli | mcp | companion | agent | routine | unknown`,
      run: (args) => searchChats(host, args),
    },
    ...outsideAgentCommands(host),
    ...chatToolCommands(host),
  ];
}

/** Inspecting and running one chat, the tools, settings and install: their own group of commands. */
function chatToolCommands(host: DaemonHost): Command[] {
  return [
    stopCommand(host),
    {
      name: "review",
      group: "Aeon",
      summary: "mark a chat reviewed, with findings",
      help: `Usage: aeon review <chatId> [note | @file.md]`,
      run: (args) => review(host, ["mark", ...args.positional]),
    },
    {
      name: "result",
      group: "Aeon",
      summary: "a chat's final answer",
      help: `Usage: aeon result <chatId>`,
      run: (args) => inspectChat(host, "result", args),
    },
    {
      name: "trace",
      group: "Aeon",
      summary: "a chat's tool calls, results and errors",
      help: `Usage: aeon trace <chatId> [--json]`,
      run: (args) => inspectChat(host, "trace", args),
    },
    {
      name: "open",
      group: "Aeon",
      summary: "show a chat as a tab in Chrome",
      help: `Usage: aeon open <chatId>`,
      run: async (args) => {
        const client = await host.connect();
        const chatId = args.positional[0];
        if (!chatId) throw new Error("Usage: aeon open <chatId>");
        const browsers = await client.openChat(chatId, true);
        process.stdout.write(browsers ? "Opened.\n" : "No connected Chrome has Aeon loaded.\n");
        return browsers ? 0 : 1;
      },
    },
    {
      name: "tools",
      group: "Aeon",
      summary: "the browser tools and their full guidance",
      help: `Usage: aeon tools [--find <topic>] [--json]

Searches every tool's name, guidance and input schema, so "what can you do about media" is one
call instead of 40 KB of prose. --json prints the matching tools.`,
      run: async (args) => listTools(await host.connect(), has(args, "json"), flag(args, "find")),
    },
    {
      name: "tool",
      group: "Aeon",
      summary: "run one chat tool",
      help: `Usage: aeon tool <browser_code|browser_tabs|crawl|site_mapper|extract> '<json>'
       [--session name] [--json] [--no-color]

--json prints one machine-readable envelope (no ANSI); output is plain automatically when stdout
is not a terminal.`,
      run: async (args) => {
        const session = flag(args, "session");
        return runTool(await host.connect(), [
          ...args.positional,
          ...(session ? ["--session", session] : []),
          ...(has(args, "json") ? ["--json"] : []),
          ...(has(args, "no-color") ? ["--no-color"] : []),
        ]);
      },
    },
    {
      name: "settings",
      group: "Aeon",
      summary: "the agent settings in the connected Chrome",
      help: `Usage: aeon settings [get]\n       aeon settings set agentInFront=true hideAgentCursor=true agentTabView=auto|split|thumbnails`,
      run: async (args) => settingsCommand(await host.connect(), args.positional),
    },
    {
      name: "install",
      group: "Aeon",
      summary: "put the aeon command on the PATH and link the Aeon skill",
      help: `Usage: aeon install`,
      run: () => install(),
    },
  ];
}

async function inspectChat(
  host: DaemonHost,
  kind: "result" | "trace",
  args: Args,
): Promise<number> {
  const chatId = args.positional[0];
  if (!chatId) throw new Error(`Usage: aeon ${kind} <chatId>`);
  const result = await inspect(await host.connect(), chatId);
  process.stdout.write(
    (kind === "result"
      ? result.answer
      : has(args, "json")
        ? JSON.stringify(result, null, 2)
        : formatTrace(result)) + "\n",
  );
  return 0;
}

function signin(args: Args): Promise<number> {
  return signinCommand(args.positional);
}

function mcp(args: Args): Promise<number> {
  const site = flag(args, "site") ?? args.positional[0];
  return runMcpServer(site).then(() => 0);
}

async function cdp(host: DaemonHost, args: Args): Promise<number> {
  const client = await host.connect();
  const action = has(args, "status") ? "status" : has(args, "stop") ? "stop" : "start";
  const reply = await client.cdp({
    action,
    ...(action === "start" ? { port: Number(flag(args, "port") ?? 9333) } : {}),
  });
  if (reply.error) throw new Error(String(reply.error));
  if (has(args, "json")) {
    process.stdout.write(JSON.stringify(reply, null, 2) + "\n");
    return reply.running ? 0 : 1;
  }
  if (!reply.running) {
    process.stdout.write("The CDP endpoint is not running. Start it: aeon cdp\n");
    return 1;
  }
  process.stdout.write(`CDP endpoint: ${String(reply.connectUrl ?? reply.url)}\n`);
  process.stdout.write(`Browser WebSocket: ${String(reply.wsUrl)}\n`);
  process.stdout.write(
    `Playwright: chromium.connectOverCDP("${String(reply.connectUrl ?? reply.url)}")\n`,
  );
  return 0;
}

export function aeonCommands(host: DaemonHost): Command[] {
  const overrides = new Map<string, Command>();
  for (const command of [
    ...setupCommands(host),
    ...browserCommands(host),
    ...providerCommands(host),
    ...blockedCommands(host),
  ])
    overrides.set(command.name, command);
  overrides.set("signin", {
    name: "signin",
    group: "Sign in",
    summary: "choose the password manager Aeon signs in with, or check it",
    help: `Usage: aeon signin setup <bitwarden|proton>
       aeon signin status

  setup bitwarden   unlock Bitwarden with \`bw\` and save a session key only you can read
  setup proton      use Proton Pass through its \`pass-cli\` (it keeps its own session)
  status            say which password manager answers, and whether it is unlocked`,
    run: signin,
  });
  overrides.set("mcp", {
    name: "mcp",
    group: "Browser",
    summary: "stdio MCP server: browser_code, browser_tabs, crawl, site_mapper",
    help: `Usage: aeon mcp [site]

Without a site: Aeon's chats and its tools for another agent. With a site: one mapped site's
operations as MCP tools, with the user's logins. (--site=<site> is accepted too.)`,
    run: mcp,
  });
  overrides.set("cdp", {
    name: "cdp",
    group: "Browser",
    summary: "local DevTools Protocol endpoint for Playwright and Puppeteer",
    help: `Usage: aeon cdp [--port 9333] [--status] [--stop] [--json]

Starts a 127.0.0.1-only CDP endpoint over Aeon's agent tabs, through the running daemon. The
printed URL carries a token. Playwright: chromium.connectOverCDP(url). Puppeteer:
connect({browserURL: url}). Tabs opened through the endpoint close when the client disconnects.`,
    run: (args) => cdp(host, args),
  });
  overrides.set("update", {
    name: "update",
    group: "Browser",
    summary: "update Aeon and browserkit, rebuild, and set everything up again",
    help: `Usage: aeon update

Runs scripts/setup.mjs in this checkout after pulling it (fast-forward only): it pulls and builds
browserkit, rebuilds Aeon, updates the native host and waits for the extension to reconnect
(reload it in chrome://extensions).`,
    run: () => updateAeon(),
  });
  const commands = BROWSERKIT_COMMANDS.map((command) => overrides.get(command.name) ?? command);
  return [...aeonOnlyCommands(host), ...commands];
}

/** aeon update: pull this checkout (fast-forward only), then run the one-command setup again. */
function updateAeon(): Promise<number> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git(["status", "--porcelain"])) {
    process.stdout.write(`Local changes in ${root}; commit or stash them first.\n`);
    return Promise.resolve(1);
  }
  git(["pull", "--ff-only"]);
  execFileSync(process.execPath, [join(root, "scripts", "setup.mjs"), "--no-agents"], {
    cwd: root,
    stdio: "inherit",
  });
  return Promise.resolve(0);
}
