// Real-Chrome speed budget for the most common loop: open a tab, read it, close it. One trivial
// page, three rounds in a row, then twelve tabs at once. Budgets: a serial round within 1.0 s and
// twelve parallel tabs within 8 s, each doubled here (2.0 s, 16 s) as the CI margin, since shared
// runners are slower and noisier than a developer machine. Every step's time is printed.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { missingChrome, readLine, startBridgeChrome } from "./helpers/bridge-chrome.mjs";

const SERIAL_BUDGET_MS = 1000 * 2;
const PARALLEL_BUDGET_MS = 8000 * 2;

const PAGE = `<!doctype html><meta charset="utf-8"><title>Plain</title><p>plain page</p>`;

const CELL = (url) => `
const rounds = [];
for (let i = 0; i < 4; i++) {
  const t0 = Date.now();
  const p = await browser.openTab(${JSON.stringify(url)} + '?s=' + i, {newTab: true});
  const t1 = Date.now();
  const r = await p.read();
  const t2 = Date.now();
  await p.close();
  const t3 = Date.now();
  rounds.push({open: t1 - t0, read: t2 - t1, close: t3 - t2, total: t3 - t0, ok: r.text.includes('plain page')});
}
const t0 = Date.now();
const parallel = await Promise.all(Array.from({length: 12}, async (_, i) => {
  const a = Date.now();
  const p = await browser.openTab(${JSON.stringify(url)} + '?p=' + i, {newTab: true});
  const b = Date.now();
  const r = await p.read();
  const c = Date.now();
  await p.close();
  return {open: b - a, read: c - b, close: Date.now() - c, ok: r.text.includes('plain page')};
}));
console.log('SPEED ' + JSON.stringify({rounds, parallelMs: Date.now() - t0, parallel}));
`;

test(
  "open, read and close a trivial page fast, serially and in parallel",
  { skip: missingChrome() },
  async () => {
    const site = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(PAGE);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${site.address().port}/plain`;
    const chrome = await startBridgeChrome("read-speed");
    try {
      const out = await chrome.repl(CELL(url), 180000);
      const speed = readLine(out.stdout, "SPEED");
      assert.ok(speed, out.stdout + out.stderr);
      console.log("SPEED " + JSON.stringify(speed));
      for (const round of speed.rounds) assert.ok(round.ok, JSON.stringify(round));
      for (const tab of speed.parallel) assert.ok(tab.ok, JSON.stringify(tab));
      // The first round warms the debugger and the realm; the budget is for the rounds after it.
      for (const round of speed.rounds.slice(1))
        assert.ok(round.total <= SERIAL_BUDGET_MS, `serial round ${round.total} ms`);
      assert.ok(speed.parallelMs <= PARALLEL_BUDGET_MS, `12 parallel tabs ${speed.parallelMs} ms`);
    } finally {
      await chrome.stop();
      site.close();
    }
  },
);
