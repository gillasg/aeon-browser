import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// Names and default paths only. A directory that does not exist is left alone, so a machine
// without that agent is not given a new config.

export interface McpServer {
  name: string;
  command: string;
  args: string[];
}

export interface AgentTarget {
  id: string;
  name: string;
  file: string;
  kind: "json" | "toml" | "yaml" | "claude";
  /** JSON container, TOML table, or YAML map that holds this server. */
  container: string;
}

interface Dirs {
  home: string;
  config: string;
  app: string;
  explicit: boolean;
}

const JSON_ROWS: { id: string; name: string; container: string; file: (dirs: Dirs) => string }[] = [
  {
    id: "cursor",
    name: "Cursor",
    container: "mcpServers",
    file: (d) => join(d.home, ".cursor", "mcp.json"),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    container: "mcpServers",
    file: (d) => join(d.home, ".gemini", "settings.json"),
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    container: "mcpServers",
    file: (d) => join(d.app, "Claude", "claude_desktop_config.json"),
  },
  {
    id: "vscode",
    name: "VS Code",
    container: "servers",
    file: (d) => join(d.app, "Code", "User", "mcp.json"),
  },
  {
    id: "windsurf",
    name: "Windsurf",
    container: "mcpServers",
    file: (d) => join(d.home, ".codeium", "windsurf", "mcp_config.json"),
  },
  {
    id: "pi",
    name: "Pi",
    container: "mcpServers",
    file: (d) => join(d.home, ".pi", "agent", "mcp.json"),
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    container: "mcpServers",
    file: (d) => join(d.home, ".copilot", "mcp-config.json"),
  },
  {
    id: "kiro",
    name: "Kiro",
    container: "mcpServers",
    file: (d) => join(d.home, ".kiro", "settings", "mcp.json"),
  },
  {
    id: "droid",
    name: "Factory Droid",
    container: "mcpServers",
    file: (d) => join(d.home, ".factory", "mcp.json"),
  },
  {
    id: "warp",
    name: "Warp",
    container: "mcpServers",
    file: (d) => join(d.home, ".warp", ".mcp.json"),
  },
  {
    id: "junie",
    name: "Junie",
    container: "mcpServers",
    file: (d) => join(d.home, ".junie", "mcp", "mcp.json"),
  },
  {
    id: "kimi",
    name: "Kimi Code CLI",
    container: "mcpServers",
    file: (d) => join(d.home, ".kimi", "mcp.json"),
  },
  {
    id: "lm-studio",
    name: "LM Studio",
    container: "mcpServers",
    file: (d) => join(d.home, ".lmstudio", "mcp.json"),
  },
  {
    id: "qwen",
    name: "Qwen Code",
    container: "mcpServers",
    file: (d) => join(d.home, ".qwen", "settings.json"),
  },
  {
    id: "augment",
    name: "Augment",
    container: "mcpServers",
    file: (d) => join(d.home, ".augment", "settings.json"),
  },
  {
    id: "cline",
    name: "Cline",
    container: "mcpServers",
    file: (d) => join(d.home, ".cline", "data", "settings", "cline_mcp_settings.json"),
  },
  {
    id: "cortex",
    name: "Cortex Code",
    container: "mcpServers",
    file: (d) => join(d.home, ".snowflake", "cortex", "mcp.json"),
  },
];

export function agentTargets(home = homedir(), explicit = false): AgentTarget[] {
  const dirs = directories(home, explicit);
  const targets: AgentTarget[] = [];
  for (const row of JSON_ROWS) {
    const file = row.file(dirs);
    if (existsSync(dirname(file)))
      targets.push({ id: row.id, name: row.name, file, kind: "json", container: row.container });
  }
  const opencode = opencodeFile(dirs);
  if (opencode)
    targets.push({
      id: "opencode",
      name: "opencode",
      file: opencode,
      kind: "json",
      container: "mcp",
    });
  pushIfDir(targets, dirs.home, ".codex", "config.toml", "codex", "Codex", "toml", "mcp_servers");
  pushIfDir(targets, dirs.home, ".grok", "config.toml", "grok", "Grok", "toml", "mcp_servers");
  pushIfDir(
    targets,
    dirs.home,
    ".hermes",
    "config.yaml",
    "hermes",
    "Hermes",
    "yaml",
    "mcp_servers",
  );
  return targets;
}

export function jsonServerValue(server: McpServer): { command: string; args: string[] } {
  return { command: server.command, args: server.args };
}

/** OpenCode's local server object. `mcp` is a map of names, which is the shape Graft already writes. */
export function opencodeValue(server: McpServer): {
  type: "local";
  command: string[];
  enabled: true;
} {
  return { type: "local", command: [server.command, ...server.args], enabled: true };
}

export function tomlBlock(server: McpServer): string {
  return [
    `[mcp_servers.${server.name}]`,
    `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`,
    "",
  ].join("\n");
}

export function yamlBlock(server: McpServer): string {
  return [
    `  ${server.name}:`,
    `    command: ${JSON.stringify(server.command)}`,
    `    args: ${JSON.stringify(server.args)}`,
  ].join("\n");
}

function directories(home: string, explicit: boolean): Dirs {
  const config =
    !explicit && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(home, ".config");
  const app =
    process.platform === "win32"
      ? !explicit && process.env.APPDATA
        ? process.env.APPDATA
        : join(home, "AppData", "Roaming")
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support")
        : config;
  return { home, config, app, explicit };
}

function opencodeFile(dirs: Dirs): string | undefined {
  const dir = join(dirs.config, "opencode");
  if (!existsSync(dir)) return undefined;
  const json = join(dir, "opencode.json");
  const jsonc = join(dir, "opencode.jsonc");
  if (existsSync(json)) return json;
  if (existsSync(jsonc)) return jsonc;
  return json;
}

function pushIfDir(
  targets: AgentTarget[],
  home: string,
  directory: string,
  file: string,
  id: string,
  name: string,
  kind: AgentTarget["kind"],
  container: string,
): void {
  const dir = join(home, directory);
  if (!existsSync(dir)) return;
  targets.push({ id, name, file: join(dir, file), kind, container });
}
