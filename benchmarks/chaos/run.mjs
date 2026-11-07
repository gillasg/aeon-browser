#!/usr/bin/env node
// Chaos suite: Aeon under load and faults, in the user's Chrome. No model is called.
//
// 1. concurrent: N sessions at once, each opening a local page, reading it and closing the tab.
// 2. leak: the browser's tab count before and after; every tab a cell opened must be gone.
// 3. timeout: a cell that never ends must fail within its limit, and the next cell must work.
// 4. daemon (only with --kill-daemon): kill the daemon mid-idle and time how long until a cell
//    works again (the supervisor restarts it).
//
//   node benchmarks/chaos/run.mjs --browser eval [--sessions 6] [--kill-daemon] [--out dir]
//
// It opens tabs in the named Chrome profile, so it never runs in CI. Results: <out>/results.json
// (default benchmarks/chaos/results/<time>/). Exit code 1 when any check failed.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = import.meta.dirname;
const root = path.resolve(here, "../..");
const cli = path.join(root, "apps/cli/dist/cli.js");

/** One `aeon repl` cell, asynchronously so several run at once. */
export function cell(code, { browser, session, timeoutSeconds = 60 }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const args = [cli, "repl", code, "--session", session, "--timeout", String(timeoutSeconds)];
    if (browser) args.push("--browser", browser);
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.stderr.on("data", (chunk) => (text += chunk));
    const killer = setTimeout(() => child.kill(), (timeoutSeconds + 30) * 1000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, ms: Date.now() - started, ...parseResult(text) });
    });
  });
}

export function parseResult(text) {
  const marker = /RESULT (.*)/.exec(text);
  let value;
  try {
    value = marker ? JSON.parse(marker[1]) : undefined;
  } catch {
    value = undefined;
  }
  const error =
    value === undefined ? text.trim().split("\n").slice(-3).join(" ").slice(0, 300) : undefined;
  return { value, ...(error ? { error } : {}) };
}

export const tabCountCode = `console.log("RESULT " + JSON.stringify((await browser.tabs()).length));`;

export function visitCode(url, id) {
  return `page = await browser.openTab(${JSON.stringify(`${url}?s=${id}`)});
const title = await page.title();
await page.close();
console.log("RESULT " + JSON.stringify({ title }));`;
}

export const hangCode = `await new Promise(() => {});`;

/** A summary line per check, and whether it passed. */
export function judge(results) {
  const lines = [];
  let ok = true;
  const add = (pass, line) => {
    ok &&= pass;
    lines.push(`${pass ? "ok  " : "FAIL"} ${line}`);
  };
  if (results.concurrent) {
    const { runs, wallMs } = results.concurrent;
    const good = runs.filter((run) => run.value?.title === "chaos").length;
    add(good === runs.length, `concurrent: ${good}/${runs.length} sessions in ${wallMs} ms`);
  }
  if (results.leak)
    add(
      results.leak.after === results.leak.before,
      `leak: ${results.leak.before} tabs before, ${results.leak.after} after`,
    );
  if (results.timeout) {
    const { hang, next, limitSeconds } = results.timeout;
    add(
      hang.status !== 0 && hang.ms < (limitSeconds + 20) * 1000,
      `timeout: a hung cell ended after ${hang.ms} ms (limit ${limitSeconds} s)`,
    );
    add(
      next.value !== undefined,
      `timeout: the next cell ${next.value !== undefined ? "worked" : "failed: " + next.error}`,
    );
  }
  if (results.daemon) {
    const { recoveredMs, boundMs } = results.daemon;
    add(
      recoveredMs !== null && recoveredMs <= boundMs,
      `daemon: ${recoveredMs === null ? "never came back" : `answered again after ${recoveredMs} ms`} (bound ${boundMs} ms)`,
    );
  }
  return { ok, lines };
}

function servePage() {
  const server = http.createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>chaos</title><p>chaos</p>");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function daemonPids() {
  const out = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*--managed-daemon*' } | ForEach-Object { $_.ProcessId }",
    ],
    { encoding: "utf8" },
  );
  return out.split(/\s+/).filter(Boolean).map(Number);
}

async function killDaemon(browser) {
  const boundMs = 90_000;
  for (const pid of daemonPids()) process.kill(pid);
  const killedAt = Date.now();
  while (Date.now() - killedAt < boundMs) {
    const probe = await cell(tabCountCode, {
      browser,
      session: "chaos-daemon",
      timeoutSeconds: 15,
    });
    if (probe.value !== undefined) return { recoveredMs: Date.now() - killedAt, boundMs };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { recoveredMs: null, boundMs };
}

async function main() {
  const { values } = parseArgs({
    options: {
      browser: { type: "string" },
      sessions: { type: "string", default: "6" },
      "kill-daemon": { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  const browser = values.browser;
  const out =
    values.out ?? path.join(here, "results", new Date().toISOString().replace(/[:.]/g, "-"));
  const server = await servePage();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const results = {};
  try {
    const before = (await cell(tabCountCode, { browser, session: "chaos-count" })).value;
    const started = Date.now();
    const runs = await Promise.all(
      Array.from({ length: Number(values.sessions) }, (_, i) =>
        cell(visitCode(url, i), { browser, session: `chaos-${i}` }),
      ),
    );
    results.concurrent = { runs, wallMs: Date.now() - started };
    const limitSeconds = 8;
    const hang = await cell(hangCode, {
      browser,
      session: "chaos-hang",
      timeoutSeconds: limitSeconds,
    });
    const next = await cell(visitCode(url, "next"), { browser, session: "chaos-hang" });
    results.timeout = { hang, next, limitSeconds };
    const after = (await cell(tabCountCode, { browser, session: "chaos-count" })).value;
    results.leak = { before, after };
    if (values["kill-daemon"]) results.daemon = await killDaemon(browser);
  } finally {
    server.close();
  }
  const verdict = judge(results);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, "results.json"),
    JSON.stringify({ ...results, verdict }, null, 2),
  );
  console.log(verdict.lines.join("\n"));
  console.log(`results: ${out}`);
  process.exitCode = verdict.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
