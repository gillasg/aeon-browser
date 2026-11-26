// The lean paths: `aeon --version` loads almost nothing, `aeon call|find|watch|status` load a
// fraction of the full command line with the same commands, and repl flags work after the code.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { commandHelp } from "browserkit/dist/usage.js";
import { aeonCommands } from "../dist/commands.js";
import { DaemonHost } from "../dist/host.js";
import { replArgs } from "../dist/repl-fast.js";
import { SITE_FAST_COMMANDS, siteFastCommand } from "../dist/site-fast.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// Counts every module Node loads (built-ins included) and prints the total on exit.
const COUNTER = `import { registerHooks } from "node:module";
let count = 0;
registerHooks({ load(url, context, next) { count++; return next(url, context); } });
process.on("exit", () => process.stderr.write("\\nMODULES " + count + "\\n"));`;

async function modulesLoaded(args, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "aeon-modules-"));
  const counter = join(dir, "counter.mjs");
  await writeFile(counter, COUNTER);
  try {
    const result = await run(
      process.execPath,
      ["--import", pathToFileURL(counter).href, cli, ...args],
      {
        env: { ...process.env, ...env },
      },
    ).catch((error) => error);
    const count = Number(/MODULES (\d+)/.exec(String(result.stderr))?.[1]);
    return { count, stdout: String(result.stdout), code: result.code ?? 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("aeon --version, -v and -V print the package version and load under 100 modules", async () => {
  for (const flag of ["--version", "-v", "-V", "version"]) {
    const { count, stdout, code } = await modulesLoaded([flag]);
    assert.equal(stdout, `aeon ${manifest.version}\n`, flag);
    assert.equal(code, 0, flag);
    assert.ok(count < 100, `${flag} loaded ${count} modules`);
  }
});

test("aeon call --help loads a fraction of the full command line", async () => {
  const fast = await modulesLoaded(["call", "--help"]);
  const full = await modulesLoaded(["map", "--help"]);
  assert.match(fast.stdout, /^Usage: aeon call <site> <operation>/);
  assert.equal(fast.code, 0);
  assert.ok(fast.count * 2 < full.count, `call ${fast.count} vs full ${full.count} modules`);
});

test("the lean commands are the ones the full command line runs", async () => {
  const host = new DaemonHost();
  try {
    const full = aeonCommands(host);
    assert.deepEqual([...SITE_FAST_COMMANDS].sort(), ["call", "find", "status", "watch"]);
    for (const name of SITE_FAST_COMMANDS) {
      const lean = await siteFastCommand(name, host);
      const expected = full.find((command) => command.name === name);
      assert.ok(lean && expected, name);
      assert.equal(commandHelp(lean, "aeon"), commandHelp(expected, "aeon"), name);
      assert.equal(lean.group, expected.group, name);
    }
    assert.equal(await siteFastCommand("map", host), undefined);
  } finally {
    host.close();
  }
});

test("aeon call and find without input print and exit exactly like the full command line", async () => {
  const main = fileURLToPath(new URL("../dist/cli-main.js", import.meta.url));
  const outcome = (script, args) =>
    run(process.execPath, [script, ...args]).then(
      (done) => ({ code: 0, stdout: done.stdout, stderr: done.stderr }),
      (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );
  for (const args of [["call"], ["call", "--json"], ["call", "x"], ["find", "--help"]]) {
    const lean = await outcome(cli, args);
    const full = await outcome(main, args);
    assert.deepEqual(lean, full, args.join(" "));
  }
});

test("repl flags work after the code, and -- ends them", () => {
  assert.deepEqual(replArgs(["repl", "1+1", "-q"]), {
    positional: ["repl", "1+1"],
    flags: { quiet: true },
  });
  assert.deepEqual(replArgs(["repl", "1+1", "--quiet", "--session", "s"]), {
    positional: ["repl", "1+1"],
    flags: { quiet: true, session: "s" },
  });
  assert.deepEqual(replArgs(["repl", "-q", "--", "-q", "--quiet"]), {
    positional: ["repl", "-q", "--quiet"],
    flags: { quiet: true },
  });
});
