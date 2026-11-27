// Bytes and tokens of the system prompt, the tool definitions and the first turn.
// Growth over browser/docs/agent/footprint-baseline.json fails unless --bump is passed.
//
// Measured from SOURCE, never from a checked-in dist: pi-adapter is compiled fresh to a temp
// directory before the surface is built. A stale or missing dist, or a different checkout path,
// can no longer change the number — the same commit measures the same bytes anywhere.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createPortable } from "./footprint-paths.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const graftRepo = resolve(repo, "..");
const baselinePath = join(repo, "docs", "agent", "footprint-baseline.json");
const bump = process.argv.includes("--bump");
const piAdapter = join(graftRepo, "packages", "pi-adapter");

const measured = await measure();
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
  // The compiled surface imports workspace packages, so the temp output must live inside the
  // checkout for Node's package resolution to find node_modules. The random suffix is neutralised
  // by createPortable below so it never reaches the byte count.
  const temp = await mkdtemp(join(piAdapter, ".agent-footprint-"));
  let scratch;
  try {
    const out = join(temp, "out");
    // Run TypeScript's own entry through Node: node_modules/.bin/tsc is a .cmd shim on Windows,
    // which spawnSync cannot start without a shell.
    const tsc = join(graftRepo, "node_modules", "typescript", "bin", "tsc");
    const compiled = spawnSync(
      process.execPath,
      [
        tsc,
        "-p",
        join(piAdapter, "tsconfig.json"),
        "--outDir",
        out,
        "--tsBuildInfoFile",
        join(temp, "tsconfig.tsbuildinfo"),
        "--pretty",
        "false",
      ],
      { encoding: "utf8", cwd: graftRepo },
    );
    if (compiled.status !== 0) {
      throw new Error(
        `Could not compile pi-adapter source for the footprint check:\n${compiled.error?.message ?? ""}${compiled.stdout ?? ""}${compiled.stderr ?? ""}`,
      );
    }
    const { buildAgentSurface } = await import(pathToFileURL(join(out, "agent-surface.js")).href);
    scratch = await mkdtemp(join(tmpdir(), "graft-footprint-"));
    const surface = await buildAgentSurface({
      workingDirectory: join(scratch, "workspace"),
      agentDirectory: join(scratch, "agent"),
      sessionDirectory: join(scratch, "sessions"),
    });
    // Machine paths in the prompt must not change the budget: the same source measured from the
    // main checkout, a worktree or a temp directory is the same prompt to the model. Strip the
    // scratch root, the checkout root and this compile directory (raw and JSON-escaped forms).
    const portable = createPortable([
      [scratch, "<workspace>"],
      [temp, "<surface>"],
      [graftRepo, "<graft>"],
    ]);
    const systemPrompt = Buffer.byteLength(portable(surface.systemPrompt));
    const tools = Buffer.byteLength(portable(JSON.stringify(surface.tools)));
    const firstTurn = Buffer.byteLength(portable(surface.firstTurn));
    return { systemPrompt, tools, firstTurn, total: systemPrompt + tools + firstTurn };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    await rm(temp, { recursive: true, force: true });
  }
}
