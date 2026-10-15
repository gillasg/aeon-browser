#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AeonClient, dataDirectory } from "./client.js";
import { inspect, runTasks, type RunOptions } from "./run.js";
import type { ChatResult } from "./results.js";
import { runMcpServer } from "./mcp.js";
import { install } from "./install.js";
import { listTools, runTool } from "./tools.js";

const usage = `aeon: run and inspect Aeon chats from the terminal or another agent.

  run "<task>" ["<task>" ...]   run tasks as Aeon chats (each opens as a Chrome tab)
      --file tasks.txt|json     tasks from a file (one per line, or a JSON array)
      --parallel 5              chats at once (default 5)
      --quiet                   do not open chat tabs
      --model provider/id       model (default: Pi's default)
      --thinking level          thinking level (default: the model's default)
      --timeout 20              minutes per task (default 20)
      --json                    print the full results as JSON
  chats [--limit 20]            recent chats
  result <chatId>               a chat's final answer
  trace <chatId>                a chat's tool calls, results and errors
  open <chatId>                 show a chat as a tab in Chrome
  tools [--json]                the browser tools and their full guidance
  tool <name> '<json>'          run one: browser_code, browser_tabs, crawl, site_api, extract
                                (or key=value pairs: action=scrape url=https://...)
      --session name            calls in one session share variables, tabs and files
                                (the input can also be @file.json, or - for stdin)
  install                       put the aeon command on the PATH and link the Aeon skill for agents
  mcp                           run the stdio MCP server`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "mcp") return runMcpServer().then(() => 0);
  if (command === "install") return install();
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(usage + "\n");
    return command ? 0 : 1;
  }
  const client = await AeonClient.connect();
  try {
    return await dispatch(client, command, rest);
  } finally {
    client.close();
  }
}

const TOOL_COMMANDS: Record<string, (client: AeonClient, rest: string[]) => Promise<number>> = {
  tools: (client, rest) => listTools(client, rest.includes("--json")),
  tool: runTool,
};

async function dispatch(client: AeonClient, command: string, rest: string[]): Promise<number> {
  if (command === "run") return run(client, rest);
  const toolCommand = TOOL_COMMANDS[command];
  if (toolCommand) return toolCommand(client, rest);
  if (command === "chats") {
    const listed = await client.command("chat.list", {
      limit: Number(option(rest, "--limit") ?? 20),
    });
    for (const chat of listed.chats as { chatId: string; title: string; updatedAt?: string }[])
      process.stdout.write(`${chat.chatId}  ${chat.title}\n`);
    return 0;
  }
  const chatId = rest[0];
  if (!chatId) throw new Error(`Usage: aeon ${command} <chatId>`);
  if (command === "open") {
    const browsers = await client.openChat(chatId, true);
    process.stdout.write(browsers ? "Opened.\n" : "No connected Chrome has Aeon loaded.\n");
    return browsers ? 0 : 1;
  }
  const result = await inspect(client, chatId);
  if (command === "result") process.stdout.write(result.answer + "\n");
  else if (command === "trace") process.stdout.write(formatTrace(result) + "\n");
  else throw new Error(usage);
  return 0;
}

async function run(client: AeonClient, rest: string[]): Promise<number> {
  const prompts = await readPrompts(rest);
  if (!prompts.length) throw new Error('Usage: aeon run "<task>" or aeon run --file tasks.txt');
  const options = runOptions(rest);
  process.stderr.write(
    `Running ${prompts.length} task(s), ${options.parallel} at a time` +
      (options.quiet ? ".\n" : "; each opens as a background tab in Chrome.\n"),
  );
  const results = await runTasks(client, prompts, {
    ...options,
    onProgress: (line) => process.stderr.write(line + "\n"),
  });
  const report = await saveReport(results);
  if (rest.includes("--json")) process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  else for (const result of results) process.stdout.write(formatResult(result) + "\n");
  process.stderr.write(`Report: ${report}\n`);
  return results.every((result) => result.status === "finished") ? 0 : 1;
}

function runOptions(rest: string[]): RunOptions {
  const model = option(rest, "--model");
  const [provider, ...id] = (model ?? "").split("/");
  const thinking = option(rest, "--thinking");
  return {
    parallel: Math.max(1, Math.min(20, Number(option(rest, "--parallel") ?? 5))),
    quiet: rest.includes("--quiet"),
    ...(model && provider && id.length ? { model: { provider, id: id.join("/") } } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {}),
    timeoutMs: Number(option(rest, "--timeout") ?? 20) * 60_000,
  };
}

const VALUE_OPTIONS = ["--file", "--parallel", "--model", "--thinking", "--timeout", "--limit"];

async function readPrompts(rest: string[]): Promise<string[]> {
  const file = option(rest, "--file");
  const inline = rest.filter(
    (arg, index) => !arg.startsWith("--") && !VALUE_OPTIONS.includes(rest[index - 1] ?? ""),
  );
  if (!file) return inline;
  const text = await readFile(file, "utf8");
  if (file.endsWith(".json")) {
    const parsed = JSON.parse(text) as (string | { prompt: string })[];
    return [...inline, ...parsed.map((item) => (typeof item === "string" ? item : item.prompt))];
  }
  return [
    ...inline,
    ...text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ];
}

async function saveReport(results: ChatResult[]): Promise<string> {
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
  return result.trace
    .map(
      (step, index) =>
        `${index + 1}. ${step.tool}${step.error ? " [ERROR]" : ""} ${step.at}\n${step.summary}`,
    )
    .join("\n\n");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exit(1);
  },
);
