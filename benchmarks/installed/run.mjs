// Installed-artifact stress scenarios (R2 #6, refs-2026-11-16/browse.md).
//
// These drive the installed native host — the real supervisor and host process with a stand-in
// daemon — through machine sleep/resume, a dropped daemon link, and an update while a cell is in
// flight. They run against the installed layout (host-config.json, data dir and socket), not an
// in-process mock. Hand-run only: this is a subdirectory .mjs, so neither `pnpm check` nor
// `pnpm check:browser` picks it up. Opt in with `--allow-installed`.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bootstrapRequest,
  cleanup,
  createSandbox,
  nativeBootstrap,
  readJson,
  startSupervisor,
  waitFor,
  waitForReady,
  writeConfig,
} from "../../apps/native-host/test/node-helpers.mjs";
import { runUpdateWhenIdle } from "../../apps/cli/dist/update-idle.js";

export const SCENARIOS = ["sleep", "network", "update"];

/** Select scenarios by name, or all of them. Unknown words are ignored (flags are harmless). */
export function parseScenarios(args) {
  const chosen = new Set();
  for (const arg of args) {
    if (SCENARIOS.includes(arg)) chosen.add(arg);
    else if (arg === "all") for (const name of SCENARIOS) chosen.add(name);
  }
  return SCENARIOS.filter((name) => chosen.has(name));
}

export function verdict(name, ok, detail) {
  return { name, ok, detail };
}

export function summarize(results) {
  const lines = [
    "# Installed-artifact stress results",
    "",
    ...results.map((r) => `- ${r.ok ? "PASS" : "FAIL"} ${r.name} — ${r.detail} (${r.ms ?? 0} ms)`),
  ];
  return lines.join("\n") + "\n";
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const daemonPid = (sandbox) => Number(readJson(join(sandbox.data, "fake-daemon-pid")) ?? 0);
const daemonStarts = (sandbox) => {
  try {
    return readFileSync(join(sandbox.data, "fake-daemon-starts"), "utf8").trim().split("\n").length;
  } catch {
    return 0;
  }
};

async function sleepScenario({ sandbox, supervisor }) {
  const pids = [supervisor.child.pid, daemonPid(sandbox)].filter((pid) => pid > 0);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGSTOP");
    } catch {
      // Already gone.
    }
  }
  await delay(700); // the machine is asleep: no process makes progress
  let resumed = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGCONT");
      resumed += 1;
    } catch {
      // Already gone.
    }
  }
  const after = await nativeBootstrap(sandbox, bootstrapRequest(), { timeoutMs: 12_000 });
  return verdict(
    "sleep",
    after.result?.ok === true && resumed === pids.length,
    `froze and resumed ${pids.length} processes; re-bootstrap ${after.result?.ok ? "ok" : "failed"}`,
  );
}

async function networkScenario({ sandbox }) {
  const before = daemonStarts(sandbox);
  const pid = daemonPid(sandbox);
  if (pid > 0) process.kill(pid, "SIGKILL"); // the local link to the daemon drops
  await waitFor(() => daemonStarts(sandbox) >= before + 1, 8000);
  await waitForReady(sandbox, 8000);
  const after = await nativeBootstrap(sandbox, bootstrapRequest(), { timeoutMs: 12_000 });
  return verdict(
    "network",
    after.result?.ok === true,
    `link dropped; daemon restarted ${before}->${daemonStarts(sandbox)}; re-bootstrap ${after.result?.ok ? "ok" : "failed"}`,
  );
}

async function updateScenario({ sandbox }) {
  // `graft update` waits for the daemon to be idle. While a cell is in flight the update must wait,
  // and it must still run once after the cell settles — never interrupt the running cell.
  let busy = true;
  const events = [];
  const timer = setTimeout(() => {
    busy = false;
  }, 200);
  try {
    const cell = nativeBootstrap(sandbox, bootstrapRequest(), { timeoutMs: 12_000 });
    const update = runUpdateWhenIdle({
      probe: async () => {
        events.push(busy ? "busy" : "idle");
        return { idle: !busy, busy: busy ? ["cell"] : [] };
      },
      update: async () => {
        events.push("update");
        return 0;
      },
      write: () => {},
      sleep: delay,
      intervalMs: 25,
    });
    const result = await cell;
    await update;
    const updateAfterBusy =
      events.includes("busy") && events.indexOf("update") > events.lastIndexOf("busy");
    return verdict(
      "update",
      result.result?.ok === true &&
        events.filter((e) => e === "update").length === 1 &&
        updateAfterBusy,
      `cell ${result.result?.ok ? "ok" : "failed"}; update ran once after idle (${events.join(",")})`,
    );
  } finally {
    clearTimeout(timer);
  }
}

const RUNNERS = { sleep: sleepScenario, network: networkScenario, update: updateScenario };

async function withSandbox(run) {
  const sandbox = createSandbox();
  writeConfig(sandbox);
  let supervisor;
  try {
    supervisor = await startSupervisor(sandbox);
    await waitForReady(sandbox, 10_000);
    const first = await nativeBootstrap(sandbox, bootstrapRequest(), { timeoutMs: 12_000 });
    if (first.result?.ok !== true) throw new Error("The installed host never bootstrapped.");
    return await run({ sandbox, supervisor });
  } finally {
    await cleanup(sandbox, supervisor?.child);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--allow-installed")) {
    process.stdout.write(
      "Refusing to run without --allow-installed (this needs the installed host).\n",
    );
    process.exit(2);
  }
  const names = parseScenarios(args);
  if (names.length === 0) {
    process.stdout.write(`Choose a scenario: ${SCENARIOS.join(", ")} or all.\n`);
    process.exit(2);
  }
  const outIndex = args.indexOf("--out");
  const out =
    outIndex >= 0 ? args[outIndex + 1] : fileURLToPath(new URL("./results/", import.meta.url));
  const results = [];
  for (const name of names) {
    const started = Date.now();
    try {
      const result = await withSandbox(RUNNERS[name]);
      results.push({ ...result, ms: Date.now() - started });
    } catch (error) {
      results.push({ ...verdict(name, false, String(error)), ms: Date.now() - started });
    }
    process.stdout.write(
      `${results.at(-1).ok ? "PASS" : "FAIL"} ${name} — ${results.at(-1).detail}\n`,
    );
  }
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2) + "\n");
  await writeFile(join(out, "summary.md"), summarize(results));
  process.exit(results.every((result) => result.ok) ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
