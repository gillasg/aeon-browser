#!/usr/bin/env node
// Stealth bench: what sites see when Aeon drives the user's Chrome. No model is called.
//
// 1. The local probe (probe.html on 127.0.0.1) records the tells a page can read while Aeon moves
//    the mouse, clicks and types: screen vs client coordinates, empty coalesced events, untrusted
//    events, input timing, window vs worker navigator values, patched natives, automation globals,
//    the Runtime.enable console tell, focus and visibility.
// 2. Public detector pages (sannysoft, BrowserScan, CreepJS, rebrowser, deviceandbrowserinfo,
//    pixelscan, fingerprint's playground, a reCAPTCHA v3 score page): a best-effort verdict each.
// 3. The sweep: popular sites opened one by one, each reported as open, a bot wall (Aeon's own
//    challenge check) or an error. `--sweep-file` takes a JSON list of URLs.
//
//   node benchmarks/stealth/run.mjs --browser eval [--probe-only | --sites-only | --sweep-only]
//        [--sites sannysoft,creepjs] [--sweep-file urls.json] [--out dir] [--session stealth]
//
// It opens tabs in the named Chrome profile, so it never runs in CI. Results: <out>/results.json
// and summary.md (default benchmarks/stealth/results/<time>/).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = import.meta.dirname;
const root = path.resolve(here, "../..");

export const DETECTORS = [
  {
    id: "sannysoft",
    url: "https://bot.sannysoft.com/",
    waitMs: 4000,
    extract: `const cells = [...document.querySelectorAll("td")];
      return { passed: cells.filter((td) => /passed/i.test(td.className)).length,
        failed: cells.filter((td) => /failed/i.test(td.className)).map((td) => (td.previousElementSibling?.textContent || "").trim().slice(0, 60)) }`,
  },
  {
    id: "browserscan",
    url: "https://www.browserscan.net/bot-detection",
    waitMs: 8000,
    extract: `const text = document.body.innerText;
      return { result: /Test Results?:?\\s*\\n?\\s*([^\\n]+)/i.exec(text)?.[1] ?? null,
        abnormal: [...document.querySelectorAll("*")].filter((el) => !el.children.length && /^(abnormal|bot)$/i.test(el.textContent.trim())).length }`,
  },
  {
    id: "creepjs",
    url: "https://abrahamjuliot.github.io/creepjs/",
    waitMs: 15000,
    extract: `const text = document.body.innerText, pick = (re) => re.exec(text)?.[1] ?? null;
      return { headless: pick(/(\\d+%)\\s*headless/i), likeHeadless: pick(/(\\d+%)\\s*like headless/i), stealth: pick(/(\\d+%)\\s*stealth/i) }`,
  },
  {
    id: "rebrowser",
    url: "https://bot-detector.rebrowser.net/",
    waitMs: 6000,
    extract: `const rows = [...document.querySelectorAll("tr")].map((tr) => [...tr.cells].map((c) => c.innerText.trim()));
      const tests = rows.filter((cells) => cells.length >= 3 && /^\\p{Extended_Pictographic}/u.test(cells[0]));
      return { failed: tests.filter((cells) => /^(🔴|🟡|🟠)/u.test(cells[0])).map((cells) => cells[0].replace(/^\\S+\\s*/u, "")),
        passed: tests.filter((cells) => cells[0].startsWith("🟢")).length }`,
  },
  {
    id: "deviceandbrowserinfo",
    url: "https://deviceandbrowserinfo.com/are_you_a_bot",
    waitMs: 6000,
    extract: `const text = document.body.innerText;
      return { verdict: /You are (?:a )?(human|bot)/i.exec(text)?.[0] ?? null, flagged: [...text.matchAll(/"(\\w+)":\\s*true/g)].map((m) => m[1]) }`,
  },
  {
    id: "pixelscan",
    url: "https://pixelscan.net/fingerprint-check",
    waitMs: 15000,
    extract: `const text = document.body.innerText;
      return { consistent: /fingerprint is\\s*(consistent|inconsistent)/i.exec(text)?.[1] ?? null }`,
  },
  {
    id: "pixelscan-bot",
    url: "https://pixelscan.net/bot-check",
    waitMs: 12000,
    extract: `const banner = [...document.querySelectorAll("h1,h2,h3,p,span,div")].find((el) => !el.children.length && /^(You'?re .*human|Bot Behavior Detected)/i.test(el.textContent.trim()) && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
      return { verdict: banner ? banner.textContent.trim() : null }`,
  },
  {
    id: "fingerprint-playground",
    url: "https://demo.fingerprint.com/playground",
    waitMs: 12000,
    extract: `const text = document.body.innerText, signal = (label) => new RegExp(label + "\\\\t?\\\\n([^\\\\n]+)").exec(text)?.[1]?.trim() ?? null;
      return { bot: signal("Bot"), tampering: signal("Browser Tampering"), devtools: signal("Developer Tools") }`,
  },
  {
    id: "recaptcha-v3",
    url: "https://antcpt.com/score_detector/",
    waitMs: 8000,
    extract: `return { score: /score is:?\\s*([\\d.]+)/i.exec(document.body.innerText)?.[1] ?? null }`,
  },
];

/** Popular sites whose bot walls an agent meets most; the sweep checks each one opens. */
export const SWEEP = [
  "https://www.amazon.com/",
  "https://www.ebay.com/",
  "https://www.walmart.com/",
  "https://www.target.com/",
  "https://www.bestbuy.com/",
  "https://www.etsy.com/",
  "https://www.zillow.com/",
  "https://www.booking.com/",
  "https://www.airbnb.com/",
  "https://www.expedia.com/",
  "https://www.indeed.com/",
  "https://www.linkedin.com/",
  "https://www.reddit.com/",
  "https://www.nytimes.com/",
  "https://www.wsj.com/",
  "https://www.ticketmaster.com/",
  "https://www.homedepot.com/",
  "https://www.lowes.com/",
  "https://www.costco.com/",
  "https://www.nike.com/",
  "https://stockx.com/",
  "https://www.g2.com/",
  "https://www.glassdoor.com/",
  "https://www.yelp.com/",
  "https://www.tripadvisor.com/",
];

/** One cell through Aeon's CLI; the cell prints `RESULT <json>`, warnings come back with it. */
export function cell(
  code,
  { browser, session, timeoutSeconds = 120, cli = path.join(root, "apps/cli/dist/cli.js") },
) {
  const run = spawnSync(
    process.execPath,
    [
      cli,
      "repl",
      code,
      "--session",
      session,
      "--timeout",
      String(timeoutSeconds),
      ...(browser ? ["--browser", browser] : []),
    ],
    { encoding: "utf8", timeout: (timeoutSeconds + 30) * 1000 },
  );
  const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const marker = /RESULT (.*)/.exec(text);
  let value;
  try {
    value = marker ? JSON.parse(marker[1]) : undefined;
  } catch {
    value = undefined;
  }
  return {
    value,
    text,
    challenge: /challenge: ([^\n]+)/.exec(text)?.[1] ?? null,
    ok: run.status === 0 && value !== undefined,
  };
}

export function probeCode(url) {
  return `page = await browser.openTab(${JSON.stringify(url)});
await page.waitForSelector('body[data-ready="1"]');
const centre = (id) => page.evaluate((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, id);
for (const id of ["pad-a", "pad-c", "pad-b", "target"]) { const c = await centre(id); await page.mouse.move(c.x, c.y, { steps: 12 }); }
await page.locator("#target").click();
await page.locator("#text").click();
await page.keyboard.type("The quick brown fox jumps over the lazy dog");
await page.mouse.wheel(0, 200);
await page.mouse.wheel(0, -200);
await page.locator("#finish").click();
await page.waitForSelector('#report[data-done="1"]');
console.log("RESULT " + await page.evaluate(() => document.getElementById("report").textContent));
await page.close();`;
}

export function detectorCode(site) {
  return `page = await browser.openTab(${JSON.stringify(site.url)});
await page.waitForTimeout(${site.waitMs});
const verdict = await page.evaluate(async () => { ${site.extract} }).catch((error) => ({ extractError: String(error.message || error) }));
console.log("RESULT " + JSON.stringify({ url: page.url(), title: await page.title(), verdict }));
await page.close();`;
}

export function sweepCode(url) {
  return `const started = Date.now();
page = await browser.openTab(${JSON.stringify(url)});
await page.waitForTimeout(2500);
const look = await page.evaluate(() => ({ title: document.title, words: (document.body?.innerText || "").split(/\\s+/).length }));
console.log("RESULT " + JSON.stringify({ url: page.url(), ms: Date.now() - started, ...look }));
await page.close();`;
}

/** The probe's tells worth a line each in the summary. */
export function probeLines(report) {
  if (!report) return ["probe failed: no report"];
  const input = report.input ?? {};
  return [
    `screen==client on ${input.screenEqualsClient} of ${input.mousemoves} mouse moves (offset seen ${input.screenOffset?.dx?.median}, ${input.screenOffset?.dy?.median}; expected ${input.expectedScreenOffset?.dx}, ${input.expectedScreenOffset?.dy})`,
    `empty coalesced events on ${input.coalescedEmpty} of ${input.pointermoves} pointer moves; untrusted events ${input.untrusted}`,
    `mouse move gap ms ${JSON.stringify(input.mousemoveIntervalMs)}; key gap ms ${JSON.stringify(input.keyIntervalMs)}; key dwell ms ${JSON.stringify(input.keyDwellMs)}`,
    `window/worker mismatches ${JSON.stringify(report.workers?.mismatches ?? [])}`,
    `patched natives ${JSON.stringify(
      Object.entries(report.native ?? {})
        .filter(([, v]) => v !== "native")
        .map(([k]) => k),
    )}`,
    `automation globals ${JSON.stringify(report.artifacts?.automationGlobals ?? [])}; foreign nodes ${JSON.stringify(report.artifacts?.foreignNodes ?? [])}; console serialized an Error (Runtime.enable) ${report.artifacts?.consoleSerializedStack}`,
    `visibility ${report.window?.visibilityState}; focus ${report.window?.hasFocus}; inner ${JSON.stringify(report.window?.inner)}; webdriver ${report.misc?.webdriver}; plugins ${report.misc?.pluginsLength}`,
  ];
}

async function serveProbe() {
  const server = http.createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://x").pathname !== "/")
      return void response.writeHead(404).end();
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(fs.readFileSync(path.join(here, "probe.html")));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      browser: { type: "string" },
      session: { type: "string", default: `stealth-${Date.now().toString(36)}` },
      "probe-only": { type: "boolean" },
      "sites-only": { type: "boolean" },
      "sweep-only": { type: "boolean" },
      sites: { type: "string" },
      "sweep-file": { type: "string" },
      out: { type: "string" },
    },
  });
  const only = values["probe-only"]
    ? "probe"
    : values["sites-only"]
      ? "sites"
      : values["sweep-only"]
        ? "sweep"
        : null;
  const options = { browser: values.browser, session: values.session };
  const out = path.resolve(
    values.out ?? path.join(here, "results", new Date().toISOString().replace(/[:.]/g, "-")),
  );
  fs.mkdirSync(out, { recursive: true });
  const results = { startedAt: new Date().toISOString(), browser: values.browser ?? null };
  const summary = [`# Stealth bench ${results.startedAt}`, ""];

  if (!only || only === "probe") {
    const server = await serveProbe();
    try {
      const probe = cell(probeCode(server.url), options);
      results.probe = probe.value ?? { error: probe.text.slice(-1500) };
      summary.push("## Probe", "", ...probeLines(probe.value).map((line) => `- ${line}`), "");
    } finally {
      await server.close();
    }
  }
  if (!only || only === "sites") {
    const wanted = values.sites?.split(",");
    results.detectors = [];
    summary.push("## Detectors", "", "| Site | Verdict | Challenge |", "| --- | --- | --- |");
    for (const site of DETECTORS.filter((item) => !wanted || wanted.includes(item.id))) {
      process.stderr.write(`detector: ${site.id}\n`);
      const run = cell(detectorCode(site), {
        ...options,
        timeoutSeconds: Math.ceil(site.waitMs / 1000) + 90,
      });
      results.detectors.push({
        id: site.id,
        ...(run.value ?? { error: run.text.slice(-600) }),
        challenge: run.challenge,
      });
      summary.push(
        `| ${site.id} | ${JSON.stringify(
          run.value?.verdict ?? run.text.slice(-120).replace(/\s+/g, " "),
        )
          .slice(0, 240)
          .replace(/\|/g, "/")} | ${run.challenge ?? ""} |`,
      );
    }
    summary.push("");
  }
  if (!only || only === "sweep") {
    const urls = values["sweep-file"]
      ? JSON.parse(fs.readFileSync(values["sweep-file"], "utf8"))
      : SWEEP;
    results.sweep = [];
    for (const url of urls) {
      process.stderr.write(`sweep: ${url}\n`);
      const run = cell(sweepCode(url), { ...options, timeoutSeconds: 60 });
      const status = run.challenge ? "bot wall" : run.ok ? "open" : "error";
      results.sweep.push({
        url,
        status,
        challenge: run.challenge,
        ...(run.value ?? { error: run.text.slice(-300) }),
      });
    }
    const walled = results.sweep.filter((item) => item.status === "bot wall");
    summary.push(
      "## Sweep",
      "",
      `${results.sweep.filter((item) => item.status === "open").length} of ${results.sweep.length} open; walled: ${walled.map((item) => item.url).join(", ") || "none"}; errors: ${
        results.sweep
          .filter((item) => item.status === "error")
          .map((item) => item.url)
          .join(", ") || "none"
      }`,
      "",
    );
  }
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "summary.md"), summary.join("\n") + "\n");
  process.stdout.write(summary.join("\n") + "\n" + out + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
