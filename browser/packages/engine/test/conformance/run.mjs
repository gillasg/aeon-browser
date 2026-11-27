// The sweep runner: the step contract, bounded timeouts, golden transcripts and pinned
// divergences. Every step is one of ok / err / text / check / image / eventually; nothing sleeps.
// Anything that settles over time is polled every 100 ms by `eventually`, and only its last
// answer is recorded.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "./png.mjs";
import { diffValues, imageRecord, normalize } from "./normalize.mjs";

export const STEP_TIMEOUT = 25_000;
export const SCENARIO_TIMEOUT = 120_000;
// Scenarios share one engine, so a busy neighbour stretches each one; past this it is a flake magnet.
export const SLOW_SCENARIO = 60_000;
const POLL_MS = 100;
export const goldenDir = fileURLToPath(new URL("./golden/", import.meta.url));

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function bounded(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${what} gave no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The first line of an engine error: the message, without hints that vary by wording. */
export function errorHead(error) {
  return String(error).split("\n")[0].trim();
}

/** One scenario's recorder. `ctx.cell(code)` runs browser code in the scenario's own session. */
class Recorder {
  constructor(scenario, cell, context) {
    this.scenario = scenario;
    this.cell = cell;
    this.context = context;
    this.steps = [];
    this.expectations = [];
    this.raw = new Map();
  }

  record(step, kind, result) {
    if (this.steps.some((entry) => entry.step === step))
      throw new Error(`duplicate step "${step}"`);
    this.steps.push({ step, kind, result: normalize(result, this.context) });
    this.raw.set(step, result);
  }

  /** The raw (unnormalized) result of an earlier step. */
  last(step) {
    return this.raw.get(step);
  }

  expect(step, met, expected, actual) {
    if (!met)
      this.expectations.push({ scenario: this.scenario, step, pointer: "", expected, actual });
  }

  async call(code) {
    const started = Date.now();
    const reply = await bounded(this.cell(code), STEP_TIMEOUT, "step");
    if (process.env.GRAFT_CONFORMANCE_TRACE)
      process.stdout.write(
        `    [${this.scenario}] ${Date.now() - started} ms ${code.slice(0, 60).replaceAll("\n", " ")}\n`,
      );
    return reply;
  }

  /**
   * The cell must answer with a value; records it, through `project` when the raw value holds
   * something platform-specific that the step compares itself (the raw value is returned).
   */
  async ok(step, code, project = (value) => value) {
    const reply = await this.call(code);
    this.expect(step, !reply.error, "a value", errorHead(reply.error));
    this.record(
      step,
      "ok",
      reply.error ? { error: errorHead(reply.error) } : (project(reply.value) ?? null),
    );
    return reply.value;
  }

  /** The cell must fail; records the error's first line. `match` pins what it must say. */
  async err(step, code, match) {
    const reply = await this.call(code);
    const head = reply.error ? errorHead(reply.error) : undefined;
    const met = head !== undefined && (!match || match.test(head));
    this.expect(
      step,
      met,
      `an error${match ? ` matching ${match}` : ""}`,
      head ?? { value: reply.value ?? null },
    );
    this.record(step, "err", head !== undefined ? { error: head } : { value: reply.value ?? null });
    return head;
  }

  /** The cell must answer with a string. */
  async text(step, code) {
    const value = await this.ok(step, code);
    this.expect(step, typeof value === "string", "a string", typeof value);
    return value;
  }

  /** A fact checked outside the engine (request log, files on disk, Chrome's own tab list). */
  check(step, value, predicate = (item) => item === true) {
    const met = Boolean(predicate(value));
    this.expect(step, met, "the check to hold", value);
    this.record(step, "check", value);
    return value;
  }

  /** The cell answers with a PNG ({saved} path or {data} base64); records size and probed pixels. */
  async image(step, code, probes) {
    const reply = await this.call(code);
    const { saved, data } = reply.value ?? {};
    const found = typeof saved === "string" || typeof data === "string";
    this.expect(
      step,
      !reply.error && found,
      "a PNG screenshot",
      errorHead(reply.error ?? "no image"),
    );
    if (!found) return this.record(step, "image", { error: errorHead(reply.error ?? "no image") });
    const image = decodePng(data ? Buffer.from(data, "base64") : await readFile(saved));
    this.record(step, "image", imageRecord(image, probes));
  }

  /** Polls the cell every 100 ms until `predicate(value)` holds or `within` runs out. */
  async eventually(step, code, predicate, within = 10_000) {
    const deadline = Date.now() + within;
    let reply;
    for (;;) {
      reply = await this.call(code);
      if (!reply.error && predicate(reply.value)) break;
      if (Date.now() >= deadline) break;
      await pause(POLL_MS);
    }
    const met = !reply.error && predicate(reply.value);
    this.expect(
      step,
      met,
      `the condition within ${within} ms`,
      reply.error ? errorHead(reply.error) : reply.value,
    );
    this.record(
      step,
      "eventually",
      reply.error ? { error: errorHead(reply.error) } : (reply.value ?? null),
    );
    return reply.value;
  }

  /** Polls a fact outside the engine every 100 ms; records the last value. */
  async until(step, read, predicate, within = 10_000) {
    const deadline = Date.now() + within;
    let value = await read();
    while (!predicate(value) && Date.now() < deadline) {
      await pause(POLL_MS);
      value = await read();
    }
    return this.check(step, value, predicate);
  }
}

/** Runs one scenario; a thrown error or an overrun becomes one failure for that scenario. */
async function runScenario(scenario, harness, site, context) {
  const session = `conformance-${scenario.name}`;
  const cell = (code) => harness.run(code, session);
  const recorder = new Recorder(scenario.name, cell, context);
  const started = Date.now();
  let crash;
  try {
    await harness.run("cfOpened = []; 0", session);
    await bounded(
      scenario.run(recorder, { harness, site, cell }),
      SCENARIO_TIMEOUT,
      `scenario ${scenario.name}`,
    );
  } catch (error) {
    crash = errorHead(error instanceof Error ? error.message : error);
  }
  await harness.run("for (const tab of cfOpened) await tab.close(); 0", session);
  return {
    scenario: scenario.name,
    ms: Date.now() - started,
    transcript: { scenario: scenario.name, steps: recorder.steps },
    expectations: recorder.expectations,
    crash,
  };
}

/** Runs the scenarios `concurrency` at a time; any scenario marked `last` runs alone at the end. */
export async function runScenarios(
  list,
  harness,
  site,
  { concurrency = Number(process.env.GRAFT_CONFORMANCE_CONCURRENCY) || 3, context },
) {
  const ordered = list.filter((scenario) => !scenario.last);
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < ordered.length) {
      const scenario = ordered[next++];
      results.push(await runScenario(scenario, harness, site, context));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ordered.length) }, worker));
  for (const scenario of list.filter((item) => item.last))
    results.push(await runScenario(scenario, harness, site, context));
  return results;
}

/**
 * Judges a run: every expectation failure and every difference from the golden transcript must
 * match a pinned divergence exactly, and every pin that applies to a scenario that ran must
 * still occur. A pin that no longer fails is stale and fails the sweep, so a fix proves itself
 * by removing its pin.
 */
export function judge({ results, goldens, divergences, slowMs = SLOW_SCENARIO }) {
  const observed = [];
  const problems = [];
  for (const result of results) {
    if (result.crash)
      problems.push({ scenario: result.scenario, kind: "crash", message: result.crash });
    if (result.ms > slowMs)
      problems.push({
        scenario: result.scenario,
        kind: "slow",
        message: `took ${result.ms} ms (limit ${slowMs})`,
      });
    observed.push(...result.expectations);
    const golden = goldens[result.scenario];
    if (!golden) {
      problems.push({
        scenario: result.scenario,
        kind: "golden",
        message: "no golden transcript (GRAFT_CONFORMANCE_UPDATE=1 writes it)",
      });
      continue;
    }
    for (const difference of goldenDiff(golden, result.transcript))
      observed.push({ scenario: result.scenario, ...difference });
  }
  const ran = new Set(results.map((result) => result.scenario));
  const used = new Set();
  for (const failure of observed) {
    const pin = divergences.findIndex((entry) => pinMatches(entry, failure));
    if (pin >= 0) used.add(pin);
    else problems.push({ ...failure, kind: "unpinned" });
  }
  divergences.forEach((entry, index) => {
    if (ran.has(entry.scenario) && !used.has(index) && !entry.intermittent)
      problems.push({
        ...entry,
        kind: "stale-pin",
        message: "this pinned divergence no longer occurs: remove the pin",
      });
  });
  return { problems, observed };
}

/**
 * A pin matches one failing leaf exactly. An intermittent pin (a race that fails on some runs
 * only) covers every leaf of its step and is never stale, so its fix must prove itself over
 * repeated runs before the pin goes.
 */
export function pinMatches(entry, failure) {
  if (entry.scenario !== failure.scenario || entry.step !== failure.step) return false;
  return entry.intermittent ? entry.pointer === "*" : entry.pointer === failure.pointer;
}

/** Golden differences per step, each with a pointer inside that step's record. */
export function goldenDiff(golden, transcript) {
  const out = [];
  const byName = new Map(golden.steps.map((entry) => [entry.step, entry]));
  for (const entry of transcript.steps) {
    const expected = byName.get(entry.step);
    byName.delete(entry.step);
    if (!expected) {
      out.push({ step: entry.step, pointer: "/step", expected: undefined, actual: "new step" });
      continue;
    }
    for (const difference of diffValues(expected, entry))
      out.push({ step: entry.step, ...difference });
  }
  for (const missing of byName.keys())
    out.push({ step: missing, pointer: "/step", expected: "step", actual: undefined });
  return out;
}

export async function readGoldens(names) {
  const goldens = {};
  for (const name of names) {
    const file = join(goldenDir, `${name}.json`);
    if (existsSync(file)) goldens[name] = JSON.parse(await readFile(file, "utf8"));
  }
  return goldens;
}

export async function writeGoldens(results) {
  await mkdir(goldenDir, { recursive: true });
  for (const result of results)
    await writeFile(
      join(goldenDir, `${result.scenario}.json`),
      JSON.stringify(result.transcript, null, 2) + "\n",
    );
}

/** GRAFT_CONFORMANCE_OUT: transcripts, per-step results, a log and diff.json. */
export async function writeOutput(dir, { results, verdict, log, meta }) {
  await mkdir(join(dir, "transcripts"), { recursive: true });
  for (const result of results) {
    await writeFile(
      join(dir, "transcripts", `${result.scenario}.json`),
      JSON.stringify(result.transcript, null, 2) + "\n",
    );
  }
  const steps = results.map(({ scenario, ms, expectations, crash, transcript }) => ({
    scenario,
    ms,
    crash,
    steps: transcript.steps.map((entry) => ({
      step: entry.step,
      kind: entry.kind,
      passed: !expectations.some((failure) => failure.step === entry.step),
    })),
  }));
  await writeFile(
    join(dir, "results.json"),
    JSON.stringify({ meta, scenarios: steps }, null, 2) + "\n",
  );
  await writeFile(join(dir, "diff.json"), JSON.stringify(verdict, null, 2) + "\n");
  await writeFile(join(dir, "sweep.log"), log.join("\n") + "\n");
}
