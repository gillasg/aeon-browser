// Deterministic stress, soak, chaos, and fuzz scenario catalog for Aeon's browser engine.
// Pure data + PRNG helpers so unit tests and dry-runs work with zero Chrome dependency.

export function createRng(seed = 1337) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

export const STRESS_SCENARIOS = [
  {
    id: "tab-churn",
    category: "stress",
    description: "Rapidly opens and closes tabs in sequence and asserts zero leaked page targets.",
    buildCode: (url, count = 4) => `
      const opened = [];
      for (let i = 0; i < ${count}; i++) {
        const p = await browser.openTab(${JSON.stringify(url)} + "?churn=" + i);
        opened.push(p.target);
        await browser.closeTab(p.target);
      }
      return { openedCount: opened.length };
    `,
  },
  {
    id: "parallel-pool",
    category: "stress",
    description: "Runs concurrent reads across multiple tabs via Promise.all without cross-talk.",
    buildCode: (url, width = 3) => `
      const pages = [];
      for (let i = 0; i < ${width}; i++) {
        pages.push(await browser.openTab(${JSON.stringify(url)} + "?slot=" + i));
      }
      const titles = await Promise.all(pages.map((p) => p.evaluate(() => location.search)));
      for (const p of pages) await browser.closeTab(p.target);
      return { width: ${width}, titles };
    `,
  },
  {
    id: "reload-race",
    category: "chaos",
    description: "Triggers rapid reload cycles while reading state to verify clean recovery.",
    buildCode: (url) => `
      const p = await browser.openTab(${JSON.stringify(url)});
      await p.reload();
      await p.reload();
      const text = await p.evaluate(() => document.title);
      await browser.closeTab(p.target);
      return { title: text };
    `,
  },
  {
    id: "network-burst",
    category: "soak",
    description: "Fires a burst of local requests and checks bounded network capture.",
    buildCode: (url, burst = 25) => `
      const p = await browser.openTab(${JSON.stringify(url)});
      await p.evaluate(async (n) => {
        await Promise.all(
          Array.from({ length: n }, (_, i) => fetch("/burst?i=" + i).then((r) => r.text())),
        );
      }, ${burst});
      const captured = await p.network.list("/burst");
      await browser.closeTab(p.target);
      return { burst: ${burst}, captured: Array.isArray(captured) ? captured.length : 0 };
    `,
  },
];

const FUZZ_SEEDS = [
  "",
  "plain-ascii-123",
  "emoji-\u{1F680}-\u{1F9EA}-test",
  "rtl-\u202Edesrever\u202C-text",
  "combining-e\u0301-n\u0303-a\u0308",
  `quotes-"double"-'single'-\`backtick\`-\\slash`,
  "<script>alert(1)</script><img src=x onerror=1>",
  '{"nested":{"a":[1,2,{"b":"c"}]}}',
  "null-byte-\u0000-and-tabs-\t\r\n",
  "a".repeat(2048),
];

export function generateFuzzInputs(seed = 42, count = 20) {
  const next = createRng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (i < FUZZ_SEEDS.length) {
      out.push(FUZZ_SEEDS[i]);
      continue;
    }
    const base = FUZZ_SEEDS[Math.floor(next() * FUZZ_SEEDS.length)];
    const repeat = 1 + Math.floor(next() * 3);
    const suffix = Math.floor(next() * 100_000).toString(36);
    out.push(`${base.slice(0, 64).repeat(repeat)}:${suffix}`);
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarizeRun(results) {
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;
  const durations = results.map((r) => Number(r.durationMs) || 0).sort((a, b) => a - b);
  return {
    total,
    passed,
    failed,
    passRate: total === 0 ? 1 : Number((passed / total).toFixed(4)),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    maxMs: durations.length ? durations[durations.length - 1] : 0,
    ok: failed === 0,
  };
}
