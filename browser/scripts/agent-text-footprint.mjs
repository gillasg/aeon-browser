// Bytes and tokens of the system prompt, the tool definitions and the first turn.
// Growth over browser/docs/agent/footprint-baseline.json fails unless --bump is passed.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aeonRepo = resolve(repo, "..");
const baselinePath = join(repo, "docs", "agent", "footprint-baseline.json");
const bump = process.argv.includes("--bump");
const surfacePath = join(aeonRepo, "packages", "pi-adapter", "dist", "agent-surface.js");

const measured = await measure();
if (!measured) process.exit(0);
const tokens = Math.ceil(measured.total / 4);
process.stdout.write(
  `footprint bytes system ${measured.systemPrompt} tools ${measured.tools} firstTurn ${measured.firstTurn} total ${measured.total} (~${tokens} tokens)\n`,
);

if (!existsSync(baselinePath) || bump) {
  await writeFile(baselinePath, JSON.stringify(measured, null, 2) + "\n");
  process.stdout.write(`footprint baseline ${bump ? "bumped" : "created"} at ${baselinePath}\n`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
if (measured.total > baseline.total) {
  process.stderr.write(
    `footprint grew from ${baseline.total} to ${measured.total} bytes. Pass --bump to accept it.\n`,
  );
  process.exit(1);
}

async function measure() {
  if (!existsSync(surfacePath)) {
    process.stdout.write("footprint skipped: adapter dist is not built\n");
    return undefined;
  }
  try {
    return await fromSurface();
  } catch (error) {
    process.stdout.write(
      `footprint skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

async function fromSurface() {
  const { buildAgentSurface } = await import(pathToFileURL(surfacePath).href);
  const root = await mkdtemp(join(tmpdir(), "aeon-footprint-"));
  const surface = await buildAgentSurface({
    workingDirectory: join(root, "workspace"),
    agentDirectory: join(root, "agent"),
    sessionDirectory: join(root, "sessions"),
  });
  const systemPrompt = Buffer.byteLength(surface.systemPrompt);
  const tools = Buffer.byteLength(JSON.stringify(surface.tools));
  const firstTurn = Buffer.byteLength(surface.firstTurn);
  return { systemPrompt, tools, firstTurn, total: systemPrompt + tools + firstTurn };
}
