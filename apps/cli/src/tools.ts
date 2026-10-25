import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AeonClient, dataDirectory } from "./client.js";

// aeon tool / aeon tools: the chat tools (browser_code, browser_tabs, crawl, site_mapper, extract)
// from a shell, one call at a time, so an agent can use them in the same session without MCP.

type Json = Record<string, unknown>;
type Content = { type: string; text?: string; data?: string; mimeType?: string };

const TOOL_NAMES = [
  "browser_code",
  "browser_tabs",
  "crawl",
  "site_mapper",
  "extract",
  "chat_review",
];

/** Every tool with its full guidance, as the daemon describes it; --find narrows to a topic. */
export async function listTools(
  client: AeonClient,
  asJson: boolean,
  find?: string,
): Promise<number> {
  const reply = await client.tool({ kind: "core.tool.list" }, 15_000);
  const all = (reply.tools as { name: string; description: string; inputSchema: Json }[]) ?? [];
  const needle = find?.trim().toLowerCase();
  const tools = needle
    ? all.filter((tool) =>
        `${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema)}`
          .toLowerCase()
          .includes(needle),
      )
    : all;
  if (asJson) process.stdout.write(JSON.stringify(tools, null, 2) + "\n");
  else if (!tools.length) process.stdout.write(`No tool mentions ${JSON.stringify(find)}.\n`);
  else
    for (const tool of tools)
      process.stdout.write(
        `## ${tool.name}\n\n${tool.description}\n\nInput: ${JSON.stringify(tool.inputSchema)}\n\n`,
      );
  return tools.length ? 0 : 1;
}

async function readInput(raw: string | undefined): Promise<Json> {
  if (raw === undefined) return {};
  const text =
    raw === "-"
      ? await readStdin()
      : raw.startsWith("@")
        ? await readFile(raw.slice(1), "utf8")
        : raw;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("The tool input must be a JSON object");
  return parsed as Json;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Screenshots and other images are saved to files; their paths are printed instead. */
async function print(content: Content[], options: { plain?: boolean } = {}): Promise<void> {
  const folder = join(dataDirectory(), "cli-images");
  for (const [index, part] of content.entries()) {
    if (part.type === "text")
      process.stdout.write((options.plain ? plainText(part.text ?? "") : (part.text ?? "")) + "\n");
    else if (part.type === "image" && part.data) {
      await mkdir(folder, { recursive: true });
      const extension = (part.mimeType ?? "image/png").split("/")[1] ?? "png";
      const path = join(folder, `${Date.now()}-${index}.${extension}`);
      await writeFile(path, Buffer.from(part.data, "base64"));
      process.stdout.write(`[image saved: ${path}]\n`);
    }
  }
}

/** key=value arguments, so simple inputs need no JSON quoting: values parse as JSON when they can. */
function fromPairs(pairs: string[]): Json {
  return Object.fromEntries(
    pairs.map((pair) => {
      const at = pair.indexOf("=");
      const value = pair.slice(at + 1);
      try {
        return [pair.slice(0, at), JSON.parse(value) as unknown];
      } catch {
        return [pair.slice(0, at), value];
      }
    }),
  );
}

interface ToolInvocation {
  name: string;
  session: string;
  input: Json;
  asJson: boolean;
  plain: boolean;
}

/** The tool name, its JSON input and the output flags, from the command's words. */
async function invocationOf(rest: string[]): Promise<ToolInvocation> {
  const [name, ...others] = rest;
  if (!name || !TOOL_NAMES.includes(name))
    throw new Error(
      `Usage: aeon tool <${TOOL_NAMES.join("|")}> '<json>' [--session name] [--json]`,
    );
  const sessionIndex = others.indexOf("--session");
  const session = (sessionIndex >= 0 ? others[sessionIndex + 1] : undefined) || "cli";
  const ignored = new Set(["--json", "--no-color", "--plain", "--session"]);
  const sessionValue = sessionIndex >= 0 ? sessionIndex + 1 : -1;
  const inputs = others.filter((arg, index) => !ignored.has(arg) && index !== sessionValue);
  const pairs = inputs.filter((arg) => /^[A-Za-z_]\w*=/.test(arg));
  const input = pairs.length ? fromPairs(pairs) : await readInput(inputs[0]);
  return {
    name,
    session,
    input,
    asJson: others.includes("--json"),
    plain: others.includes("--no-color") || !process.stdout.isTTY,
  };
}

/** aeon tool <name> [json | @file | - | key=value ...] [--session s] [--json] [--no-color] */
export async function runTool(client: AeonClient, rest: string[]): Promise<number> {
  const call = await invocationOf(rest);
  const reply = await client.tool({
    kind: "core.tool.call",
    tool: call.name,
    session: call.session,
    arguments: call.input,
  });
  const content = (reply.content as Content[] | undefined) ?? [];
  const isError = reply.isError === true;
  if (call.asJson) {
    process.stdout.write(
      JSON.stringify({ tool: call.name, session: call.session, isError, content }, null, 2) + "\n",
    );
    return isError ? 1 : 0;
  }
  await print(content, { plain: call.plain });
  return isError ? 1 : 0;
}

/** ANSI is a terminal's business; a piped caller gets plain text. */
function plainText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}
