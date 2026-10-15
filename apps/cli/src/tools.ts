import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AeonClient, dataDirectory } from "./client.js";

// aeon tool / aeon tools: the chat tools (browser_code, browser_tabs, crawl, site_api, extract)
// from a shell, one call at a time, so an agent can use them in the same session without MCP.

type Json = Record<string, unknown>;
type Content = { type: string; text?: string; data?: string; mimeType?: string };

const TOOL_NAMES = ["browser_code", "browser_tabs", "crawl", "site_api", "extract"];

/** Every tool with its full guidance, as the daemon describes it. */
export async function listTools(client: AeonClient, asJson: boolean): Promise<number> {
  const reply = await client.tool({ kind: "core.tool.list" }, 15_000);
  const tools = (reply.tools as { name: string; description: string; inputSchema: Json }[]) ?? [];
  if (asJson) process.stdout.write(JSON.stringify(tools, null, 2) + "\n");
  else
    for (const tool of tools)
      process.stdout.write(
        `## ${tool.name}\n\n${tool.description}\n\nInput: ${JSON.stringify(tool.inputSchema)}\n\n`,
      );
  return 0;
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
async function print(content: Content[]): Promise<void> {
  const folder = join(dataDirectory(), "cli-images");
  for (const [index, part] of content.entries()) {
    if (part.type === "text") process.stdout.write((part.text ?? "") + "\n");
    else if (part.type === "image" && part.data) {
      await mkdir(folder, { recursive: true });
      const extension = (part.mimeType ?? "image/png").split("/")[1] ?? "png";
      const path = join(folder, `${Date.now()}-${index}.${extension}`);
      await writeFile(path, Buffer.from(part.data, "base64"));
      process.stdout.write(`[image saved: ${path}]\n`);
    }
  }
}

/** aeon tool <name> [json | @file | -] [--session s] */
export async function runTool(client: AeonClient, rest: string[]): Promise<number> {
  const [name, ...others] = rest;
  if (!name || !TOOL_NAMES.includes(name))
    throw new Error(`Usage: aeon tool <${TOOL_NAMES.join("|")}> '<json>' [--session name]`);
  const sessionIndex = others.indexOf("--session");
  const session = sessionIndex >= 0 ? others[sessionIndex + 1] : undefined;
  const sessionValue = sessionIndex >= 0 ? sessionIndex + 1 : -1;
  const raw = others.find((arg, index) => !arg.startsWith("--") && index !== sessionValue);
  const reply = await client.tool({
    kind: "core.tool.call",
    tool: name,
    session: session || "cli",
    arguments: await readInput(raw),
  });
  await print((reply.content as Content[] | undefined) ?? []);
  return reply.isError === true ? 1 : 0;
}
