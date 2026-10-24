import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { startFixtureServer } from "./fixtures.mjs";

// Runs the same task list two ways: a scripted browser_code solution through Aeon's browser
// (`aeon tool browser_code`), and Aeon's own agent (`aeon run`). It writes pass/fail, steps and
// time per task and way. It drives the user's Chrome, so real runs require --allow-browser; the
// dry run uses the fixtures in tasks.json and is what the test uses.

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tasksFile = join(root, "benchmarks", "tasks.json");

export async function loadTasks(file = tasksFile) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function runBench(options = {}) {
  const dryRun = options.dryRun !== false;
  const allowBrowser = options.allowBrowser === true;
  const cli = options.cli ?? join(root, "apps", "cli", "dist", "cli.js");
  if (!dryRun && !allowBrowser)
    throw new Error(
      "Refusing to drive the user's Chrome. Pass --allow-browser if you are sure (the bench pages are local).",
    );
  let fixtures;
  if (!dryRun) fixtures = await startFixtureServer();
  const base = fixtures?.base ?? "http://127.0.0.1:0";
  const tasks = (await loadTasks(options.tasksFile)).filter(
    (task) => !options.only || options.only.includes(task.id),
  );
  const rows = [];
  try {
    for (const task of tasks) {
      const prompt = String(task.task).replaceAll("{{base}}", base);
      if (task.script)
        rows.push(
          await timed(
            task,
            "scripted",
            async () => {
              if (dryRun)
                return { value: task.fixture?.direct, steps: task.fixture?.direct?.steps?.length };
              const code = `const base = ${JSON.stringify(base)};\n${task.script}`;
              const { stdout } = await run(
                process.execPath,
                [
                  cli,
                  "tool",
                  "browser_code",
                  JSON.stringify({ code }),
                  "--session",
                  `bench-${task.id}`,
                ],
                { timeout: 12 * 60_000, maxBuffer: 20 * 1024 * 1024 },
              );
              const value = parseToolValue(stdout);
              return { value, steps: Array.isArray(value?.steps) ? value.steps.length : 1 };
            },
            (value) => checkFacts(task.expected, value?.facts ?? value),
          ),
        );
      rows.push(
        await timed(
          task,
          "agent",
          async () => {
            if (dryRun) return { answer: task.fixture?.agent, steps: undefined };
            const { stdout } = await run(
              process.execPath,
              [cli, "run", prompt, "--quiet", "--json", "--timeout", "20"],
              { timeout: 25 * 60_000, maxBuffer: 20 * 1024 * 1024 },
            );
            const results = JSON.parse(stdout);
            const result = Array.isArray(results) ? results[0] : results;
            return { answer: String(result?.answer ?? ""), steps: result?.toolCalls };
          },
          (answer) => checkAnswer(task.expected, String(answer ?? "")),
        ),
      );
    }
  } finally {
    await fixtures?.close();
  }
  const out =
    options.out ??
    join(
      root,
      "benchmarks",
      "results",
      dryRun ? "dry-run" : new Date().toISOString().replace(/[:.]/g, "-"),
    );
  const report = { at: new Date().toISOString(), dryRun, rows };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out.endsWith(".json") ? out : `${out}.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(
    out.endsWith(".json") ? out.replace(/\.json$/, ".md") : `${out}.md`,
    markdown(report),
  );
  return { ...report, out };
}

async function timed(task, way, candidate, check) {
  const started = Date.now();
  try {
    const result = await candidate();
    return {
      task: task.id,
      way,
      pass: check(result.value ?? result.answer),
      steps: result.steps ?? 0,
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      task: task.id,
      way,
      pass: false,
      steps: 0,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkFacts(expected, facts) {
  return Object.entries(expected).every(([key, value]) =>
    String(facts?.[key] ?? "")
      .toLowerCase()
      .includes(String(value).toLowerCase()),
  );
}

function checkAnswer(expected, answer) {
  const text = answer.toLowerCase();
  return Object.values(expected).every((value) => text.includes(String(value).toLowerCase()));
}

function parseToolValue(stdout) {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith("value: "));
  if (!line) throw new Error(`browser_code returned no value:\n${stdout.slice(0, 1000)}`);
  return JSON.parse(line.slice("value: ".length));
}

function markdown(report) {
  const lines = [
    "# Test bench",
    "",
    `Run ${report.at}${report.dryRun ? " (dry run, no browser)" : ""}.`,
    "",
    "| Task | Way | Result | Steps | Time |",
    "| --- | --- | --- | ---: | ---: |",
    ...report.rows.map(
      (row) =>
        `| ${row.task} | ${row.way} | ${row.pass ? "pass" : "FAIL"}${row.error ? `: ${row.error.replace(/\|/g, "/")}` : ""} | ${row.steps} | ${row.ms} ms |`,
    ),
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const only = flag("--only");
  const dryRun = args.includes("--dry-run") || args.includes("--dry");
  const report = await runBench({
    dryRun,
    allowBrowser: args.includes("--allow-browser"),
    ...(flag("--out") ? { out: flag("--out") } : {}),
    ...(only ? { only: only.split(",").map((item) => item.trim()) } : {}),
    ...(flag("--cli") ? { cli: flag("--cli") } : {}),
  });
  process.stdout.write(markdown(report) + `\nResults: ${report.out}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
