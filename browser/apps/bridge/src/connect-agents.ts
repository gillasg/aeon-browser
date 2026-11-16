import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
  agentTargets,
  jsonServerValue,
  opencodeValue,
  tomlBlock,
  yamlBlock,
  type AgentTarget,
  type McpServer,
} from "./agent-table.js";
import { spliceJson, spliceToml, spliceYaml } from "./config-text.js";

export type { McpServer } from "./agent-table.js";

// Adds an MCP server to the coding agents already set up on this machine. An entry that is
// already there is replaced. Comments and every other key stay. Safe to rerun.

export interface AgentResult {
  agent: string;
  done: boolean;
  detail: string;
}

export interface ConnectOptions {
  /** Throwaway or real home. Defaults to the current user. */
  home?: string;
  /** Flag ids (`opencode`, `cursor`). Absent means every agent whose config directory exists. */
  agents?: string[];
  /** Remove only this server's row. */
  uninstall?: boolean;
  /** Ask on a terminal. A pipe never waits: it reports the ids instead. */
  pick?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function connectAgents(
  server: McpServer,
  options: ConnectOptions = {},
): Promise<AgentResult[]> {
  const home = options.home ?? homedir();
  const explicit = options.home !== undefined;
  const selected = await selectTargets(agentTargets(home, explicit), options);
  if (!Array.isArray(selected)) return [selected];
  const results: AgentResult[] = [];
  if (wantClaude(options)) {
    const claude = claudeCode(server, options.uninstall === true);
    if (claude) results.push(claude);
  }
  for (const target of selected)
    results.push(await editTarget(target, server, options.uninstall === true));
  return results;
}

async function selectTargets(
  targets: AgentTarget[],
  options: ConnectOptions,
): Promise<AgentTarget[] | AgentResult> {
  const wanted = wantedIds(options.agents);
  if (wanted) return targets.filter((target) => wanted.has(target.id));
  if (!options.pick) return targets;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const ids = targets.map((target) => target.id).join(", ");
  if (!isTerminal(input)) {
    return {
      agent: "picker",
      done: false,
      detail: `Pass --agent <id>. Config directories found: ${ids || "none"}`,
    };
  }
  output.write(
    `Agents with a config directory (${ids || "none"}).\nType ids separated by commas, or * for all:\n> `,
  );
  const answer = (await readLine(input)).trim();
  if (answer === "*") return targets;
  const chosen = new Set(answer.split(",").map((item) => item.trim()));
  return targets.filter((target) => chosen.has(target.id));
}

function wantedIds(agents: string[] | undefined): Set<string> | undefined {
  if (!agents?.length) return undefined;
  const ids = agents
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(ids);
}

function wantClaude(options: ConnectOptions): boolean {
  const wanted = wantedIds(options.agents);
  if (wanted) return wanted.has("claude");
  return options.pick !== true;
}

async function editTarget(
  target: AgentTarget,
  server: McpServer,
  uninstall: boolean,
): Promise<AgentResult> {
  try {
    await editFile(target.file, (text) => edited(text, target, server, uninstall));
    const verb = uninstall ? "removed from" : "updated";
    return { agent: target.name, done: true, detail: `${verb} ${target.file}` };
  } catch (error) {
    return {
      agent: target.name,
      done: false,
      detail:
        error instanceof Error ? error.message : `could not read ${target.file}; left as it was`,
    };
  }
}

function edited(text: string, target: AgentTarget, server: McpServer, uninstall: boolean): string {
  if (target.kind === "toml")
    return spliceToml(
      text,
      target.container,
      server.name,
      uninstall ? undefined : tomlBlock(server),
    );
  if (target.kind === "yaml") {
    const child = `  ${server.name}:`;
    return spliceYaml(text, target.container, uninstall ? undefined : yamlBlock(server), child);
  }
  const value = uninstall
    ? undefined
    : target.id === "opencode"
      ? opencodeValue(server)
      : jsonServerValue(server);
  return spliceJson(text, target.container, server.name, value);
}

async function editFile(path: string, edit: (text: string) => string): Promise<void> {
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  if (text.includes("\0")) throw new Error(`could not read ${path} as text; left as it was`);
  const next = edit(text);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next.endsWith("\n") || next === "" ? next : `${next}\n`);
}

function claudeCode(server: McpServer, uninstall: boolean): AgentResult | undefined {
  const claude = process.platform === "win32" ? "claude.cmd" : "claude";
  try {
    execFileSync(claude, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
      shell: process.platform === "win32",
    });
  } catch {
    return undefined;
  }
  const run = (args: string[]) =>
    execFileSync(claude, args, {
      stdio: "ignore",
      windowsHide: true,
      shell: process.platform === "win32",
    });
  try {
    try {
      run(["mcp", "remove", "--scope", "user", server.name]);
    } catch {
      // Not added yet, or already gone.
    }
    if (uninstall)
      return { agent: "Claude Code", done: true, detail: "claude mcp remove --scope user" };
    run(["mcp", "add", "--scope", "user", server.name, "--", server.command, ...server.args]);
    return { agent: "Claude Code", done: true, detail: "claude mcp add --scope user" };
  } catch (error) {
    return {
      agent: "Claude Code",
      done: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function isTerminal(input: NodeJS.ReadableStream): boolean {
  return "isTTY" in input && (input as { isTTY?: boolean }).isTTY === true;
}

function readLine(input: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const onData = (chunk: Buffer | string): void => {
      data += String(chunk);
      if (!data.includes("\n")) return;
      input.off?.("data", onData);
      resolve(data.split("\n")[0] ?? "");
    };
    input.on("data", onData);
    input.resume?.();
  });
}
