#!/usr/bin/env node
// Kernel bench: how fast and how steady Aeon's browser layer is, with no model. Eight everyday jobs
// (open, snapshot, read, click, fill, lazy list, three tabs, fetch), each run a few times through
// `aeon repl`; medians, successes and output size (what an agent would read) per job.
//
//   node benchmarks/kernel/run.mjs --browser eval [--reps 3] [--only id,id] [--save-baseline]
//
// A baseline (benchmarks/kernel/results/baseline.json, per machine) turns a run into a regression
// check: a job more than 25% (and 150 ms) slower, less reliable, or 25% wordier is flagged, exit 1.
// It opens tabs in the named Chrome profile, so it never runs in CI.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = import.meta.dirname;
const root = path.resolve(here, "../..");
const WIKI = "https://en.wikipedia.org/wiki/Desk_lamp";

const PAGES = {
  "/list": `<!doctype html><title>Jobs</title><ul id="jobs"></ul><div id="end" style="height:300px;padding-top:200px">Loading…</div><script>
let n = 0; const list = document.getElementById("jobs");
new IntersectionObserver(async (e, io) => { if (!e[0].isIntersecting || n >= 5) return;
  for (let i = 0; i < 10; i++) list.insertAdjacentHTML("beforeend", '<li class="job">Job ' + (n * 10 + i + 1) + '</li>');
  n++; await new Promise((r) => setTimeout(r, 200)); io.unobserve(e[0].target); io.observe(e[0].target); }).observe(document.getElementById("end"));</script>`,
  "/form": `<!doctype html><title>Form</title><form action="/done"><label for="t">Text input</label><input id="t" name="t">
<label for="s">Choice</label><select id="s" name="s"><option value="1">One</option><option value="2">Two</option></select>
<button>Submit</button></form>`,
  "/done": `<!doctype html><title>Done</title><h1>Form submitted</h1>`,
  "/a": `<!doctype html><title>Page A</title><p>A</p>`,
  "/b": `<!doctype html><title>Page B</title><p>B</p>`,
  "/c": `<!doctype html><title>Page C</title><p>C</p>`,
};

/** The jobs, as Aeon browser code against a local server at `base`. Each ends with a value. */
export function jobs(base) {
  const at = (p) => JSON.stringify(base + p);
  return [
    {
      id: "open-title",
      code: `page = await browser.openTab(${at("/a")}); const t = await page.title(); await page.close(); t`,
      expect: "Page A",
    },
    {
      id: "snapshot-wiki",
      code: `page = await browser.openTab(${JSON.stringify(WIKI)}); const s = await bu.state(); await page.close(); s.length > 500`,
      expect: true,
    },
    {
      id: "read-wiki",
      code: `page = await browser.openTab(${JSON.stringify(WIKI)}); const r = await page.read(); await page.close(); JSON.stringify(r).length > 2000`,
      expect: true,
    },
    {
      id: "click-nav",
      code: `page = await browser.openTab(${JSON.stringify(WIKI)}); await page.getByRole("link", {name: "Lamp", exact: true}).first().click(); const u = page.url(); await page.close(); u.endsWith("/wiki/Lamp")`,
      expect: true,
    },
    {
      id: "fill-form",
      code: `page = await browser.openTab(${at("/form")}); await page.getByLabel("Text input").fill("hello"); await page.locator("#s").selectOption("2"); await page.getByRole("button", {name: "Submit"}).click(); const h = await page.locator("h1").innerText(); await page.close(); h`,
      expect: "Form submitted",
    },
    {
      id: "lazy-50",
      code: `page = await browser.openTab(${at("/list")}); for (let i = 0; i < 10 && (await page.locator(".job").count()) < 50; i++) { await page.mouse.wheel(0, 3000); await page.waitForTimeout(300); } const n = await page.locator(".job").count(); await page.close(); n`,
      expect: 50,
    },
    {
      id: "three-tabs",
      code: `const titles = await Promise.all([${at("/a")}, ${at("/b")}, ${at("/c")}].map(async (u) => { const p = await browser.openTab(u, {newTab: true}); const t = await p.title(); await p.close(); return t; })); titles.join(",")`,
      expect: "Page A,Page B,Page C",
    },
    {
      id: "fetch-json",
      code: `const r = await browser.fetch(${at("/a")}, {as: "text"}); r.text.includes("Page A")`,
      expect: true,
    },
  ];
}

/** One `aeon repl` cell: wall time, success against `expect`, and how much it printed. */
export function cell(
  code,
  { browser, session = "kernel", cli = path.join(root, "apps/cli/dist/cli.js") },
) {
  const started = Date.now();
  return new Promise((resolve) => {
    const args = [
      cli,
      "repl",
      code,
      "--session",
      session,
      "--timeout",
      "60",
      ...(browser ? ["--browser", browser] : []),
    ];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (status) => resolve({ ms: Date.now() - started, status, out }));
  });
}

/** The value a cell printed last (its result), parsed when it is JSON. */
export function lastValue(out) {
  const line = out.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}

export function summarise(id, runs, expect) {
  const ok = runs.filter(
    (run) => run.status === 0 && JSON.stringify(lastValue(run.out)) === JSON.stringify(expect),
  );
  const ms = runs.map((run) => run.ms).sort((a, b) => a - b);
  return {
    id,
    medianMs: ms[Math.floor(ms.length / 2)],
    ok: ok.length,
    reps: runs.length,
    chars: Math.max(...runs.map((run) => run.out.length)),
  };
}

/** Jobs worse than the baseline: slower, less reliable, or wordier. */
export function regressions(rows, baseline) {
  const flagged = [];
  for (const row of rows) {
    const was = baseline.find((old) => old.id === row.id);
    if (!was) continue;
    if (row.medianMs > was.medianMs * 1.25 && row.medianMs - was.medianMs > 150)
      flagged.push(`${row.id}: ${was.medianMs} → ${row.medianMs} ms`);
    if (row.ok / row.reps < was.ok / was.reps)
      flagged.push(`${row.id}: ${was.ok}/${was.reps} → ${row.ok}/${row.reps} ok`);
    if (row.chars > was.chars * 1.25 && row.chars - was.chars > 200)
      flagged.push(`${row.id}: output ${was.chars} → ${row.chars} chars`);
  }
  return flagged;
}

function serve() {
  const server = http.createServer((request, response) => {
    const page = PAGES[new URL(request.url ?? "/", "http://x").pathname];
    response.writeHead(page ? 200 : 404, { "content-type": "text/html" });
    response.end(page ?? "not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const { values } = parseArgs({
    options: {
      browser: { type: "string" },
      reps: { type: "string", default: "3" },
      only: { type: "string" },
      "save-baseline": { type: "boolean", default: false },
    },
  });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const rows = [];
  try {
    await cell("1", { browser: values.browser }); // warm the connection; not timed
    for (const job of jobs(base).filter(
      (j) => !values.only || values.only.split(",").includes(j.id),
    )) {
      const runs = [];
      for (let i = 0; i < Number(values.reps); i++)
        runs.push(await cell(job.code, { browser: values.browser }));
      const row = summarise(job.id, runs, job.expect);
      rows.push(row);
      console.log(
        `${row.id.padEnd(14)} ${String(row.medianMs).padStart(6)} ms  ${row.ok}/${row.reps} ok  ${row.chars} chars`,
      );
    }
  } finally {
    server.close();
  }
  const dir = path.join(here, "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
    JSON.stringify(rows, null, 2),
  );
  const baselineFile = path.join(dir, "baseline.json");
  if (values["save-baseline"]) {
    fs.writeFileSync(baselineFile, JSON.stringify(rows, null, 2));
    console.log("saved as the baseline");
    return;
  }
  if (!fs.existsSync(baselineFile))
    return console.log("no baseline yet: rerun with --save-baseline");
  const flagged = regressions(rows, JSON.parse(fs.readFileSync(baselineFile, "utf8")));
  console.log(
    flagged.length ? `REGRESSIONS:\n${flagged.join("\n")}` : "no regressions against the baseline",
  );
  process.exitCode = flagged.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
