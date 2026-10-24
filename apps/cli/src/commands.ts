import { readFile } from "node:fs/promises";
import { COMMANDS as BROWSERKIT_COMMANDS } from "browserkit/dist/commands/index.js";
import { flag, has, type Args } from "browserkit/dist/args.js";
import type { Command } from "browserkit/dist/usage.js";
import { blockedCommands } from "./blocked.js";
import { browserCommands } from "./browser-commands.js";
import { dataDirectory } from "./client.js";
import type { DaemonHost } from "./host.js";
import { install } from "./install.js";
import { runMcpServer } from "./mcp.js";
import { inspect, runTasks, type RunOptions } from "./run.js";
import type { ChatResult } from "./results.js";
import { settingsCommand } from "./settings.js";
import { signinCommand } from "./signin.js";
import { setupCommands } from "./setup.js";
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
    onProgress: (line) => process.stderr.write(line + "\n"),
  });
  const report = await saveReport(results);
  if (has(args, "json")) process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  else for (const result of results) process.stdout.write(formatResult(result) + "\n");
  process.stderr.write(`Report: ${report}\n`);
  return results.every((result) => result.status === "finished") ? 0 : 1;
}

function runOptions(args: Args): RunOptions {
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

async function listChats(host: DaemonHost, args: Args): Promise<number> {
  const client = await host.connect();
  const limit = flag(args, "limit") ?? "20";
  if (has(args, "unreviewed")) return review(host, ["list", limit]);
  const listed = await client.command("chat.list", { limit: Math.min(100, Number(limit)) });
  for (const chat of listed.chats as { chatId: string; title: string }[])
    process.stdout.write(`${chat.chatId}  ${chat.title}\n`);
  return 0;
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
      help: `Usage: aeon chats [--limit 20] [--unreviewed]`,
      run: (args) => listChats(host, args),
    },
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
      help: `Usage: aeon tools [--json]`,
      run: async (args) => listTools(await host.connect(), has(args, "json")),
    },
    {
      name: "tool",
      group: "Aeon",
      summary: "run one chat tool",
      help: `Usage: aeon tool <browser_code|browser_tabs|crawl|site_mapper|extract> '<json>' [--session name]`,
      run: async (args) => {
        const session = flag(args, "session");
        return runTool(
          await host.connect(),
          session ? [...args.positional, "--session", session] : args.positional,
        );
      },
    },
    {
      name: "settings",
      group: "Aeon",
      summary: "the agent settings in the connected Chrome",
      help: `Usage: aeon settings [get]\n       aeon settings set agentInFront=true hideAgentCursor=true agentTabView=split|thumbnails`,
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

export function aeonCommands(host: DaemonHost): Command[] {
  const overrides = new Map<string, Command>();
  for (const command of [
    ...setupCommands(host),
    ...browserCommands(host),
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
  const commands = BROWSERKIT_COMMANDS.map((command) => overrides.get(command.name) ?? command);
  return [...aeonOnlyCommands(host), ...commands];
}
