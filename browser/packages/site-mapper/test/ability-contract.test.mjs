import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAbility, saveAbility, testAbility } from "../dist/abilities.js";
import { pageRows } from "../dist/ability-records.js";

async function withHome(run) {
  const root = await mkdtemp(join(tmpdir(), "ability-contract-"));
  const previous = process.env.SITE_TO_API_HOME;
  process.env.SITE_TO_API_HOME = root;
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.SITE_TO_API_HOME;
    else process.env.SITE_TO_API_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function ability(overrides = {}) {
  const now = new Date().toISOString();
  return {
    name: "search",
    site: "example.com",
    kind: "read",
    inputs: { type: "object", properties: { q: { type: "string" } } },
    ways: [{ kind: "api", operation: "search", params: { q: "{{inputs.q}}" } }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const rows = (ids) => ids.map((id) => ({ id: String(id), title: `item ${id}` }));

test("a migrated read pages its API again and stops once it has enough rows", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "feed",
        inputs: {},
        ways: [
          {
            kind: "api",
            operation: "feed",
            paging: { param: "cursor", next: "/next", items: "/items" },
          },
        ],
        createdBy: "import",
      }),
    );
    const calls = [];
    const host = {
      call: async (_operation, params) => {
        calls.push(params.cursor);
        const page = Number(params.cursor ?? 0);
        return { items: rows([page * 2, page * 2 + 1]), next: page < 4 ? String(page + 1) : null };
      },
    };
    const all = await runAbility("example.com", "feed", {}, { host });
    assert.equal(all.result.length, 10, "every page is read");
    calls.length = 0;
    const first = await runAbility("example.com", "feed", {}, { host, limit: 3 });
    assert.deepEqual(
      first.result.items.map((row) => row.id),
      ["0", "1", "2"],
    );
    assert.equal(first.result.has_more, true);
    assert.equal(calls.length, 2, "paging stops once the page plus one row exists");
  });
});

test("a cursor survives rows added and removed above it", () => {
  const first = pageRows(rows([1, 2, 3, 4, 5, 6]), { limit: 2 });
  assert.deepEqual(
    first.items.map((row) => row.id),
    ["1", "2"],
  );
  const inserted = pageRows(rows([0, 1, 2, 3, 4, 5, 6]), { limit: 2, cursor: first.next_cursor });
  assert.deepEqual(
    inserted.items.map((row) => row.id),
    ["3", "4"],
    "a new row on top neither repeats nor skips",
  );
  const removed = pageRows(rows([1, 3, 4, 5, 6]), { limit: 2, cursor: first.next_cursor });
  assert.deepEqual(
    removed.items.map((row) => row.id),
    ["3", "4"],
    "a returned row that vanished falls back without repeats",
  );
  const last = pageRows(rows([1, 2, 3]), { limit: 5, cursor: first.next_cursor });
  assert.equal(last.has_more, false);
  assert.equal(last.next_cursor, null);
});

test("a write never applies twice under one key", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: { type: "object", properties: { item: { type: "string" } } },
        ways: [{ kind: "api", operation: "order", params: { item: "{{inputs.item}}" } }],
      }),
    );
    let orders = 0;
    const host = { call: async () => ({ order: ++orders }) };
    const first = await runAbility("example.com", "order", { item: "tea" }, { host, key: "k1" });
    const again = await runAbility("example.com", "order", { item: "tea" }, { host, key: "k1" });
    assert.equal(orders, 1);
    assert.equal(again.write.replayed, true);
    assert.deepEqual(again.result, first.result);
    await runAbility("example.com", "order", { item: "tea" }, { host, key: "k2" });
    assert.equal(orders, 2, "a new key is a new write");
  });
});

test("a write that may have applied stops, reports it, and refuses the same key", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: { type: "object", properties: { item: { type: "string" } } },
        ways: [
          { kind: "api", operation: "order", params: { item: "{{inputs.item}}" } },
          { kind: "script", runtime: "node", code: "return 'second way ran';" },
        ],
      }),
    );
    const host = {
      call: async () => {
        throw new Error("request timed out");
      },
    };
    const failure = await runAbility("example.com", "order", { item: "tea" }, { host, key: "k" })
      .then(() => undefined)
      .catch((error) => error);
    assert.equal(failure.outcome.write_status, "may_have_applied");
    assert.equal(failure.outcome.possible_commit, true);
    assert.equal(failure.outcome.retry, "never");
    assert.match(failure.message, /read the site back/);
    assert.doesNotMatch(failure.message, /second way ran/, "no fallback after a possible commit");
    const again = await runAbility("example.com", "order", { item: "tea" }, { host, key: "k" })
      .then(() => undefined)
      .catch((error) => error);
    assert.match(again.message, /WRITE_UNCERTAIN/);
    assert.match(again.message, /read the site back/);
    assert.equal(again.outcome.retry, "never");
  });
});

test("a refused write is not applied and may fall through to the next way", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: {},
        ways: [
          { kind: "api", operation: "order" },
          { kind: "script", runtime: "node", code: "return 'by script';" },
        ],
      }),
    );
    const host = {
      call: async () => {
        throw new Error("HTTP 422 invalid size");
      },
    };
    const answer = await runAbility("example.com", "order", {}, { host });
    assert.equal(answer.result, "by script");
    assert.equal(answer.write.write_status, "applied");
  });
});

test("an unanswered write stays unknown and is not retried when the page says invalid", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: {},
        ways: [
          { kind: "api", operation: "order" },
          { kind: "script", runtime: "node", code: "return 'second way ran';" },
        ],
      }),
    );
    const error = new Error("Invalid coupon");
    error.receipt = { requests: [{ method: "POST", url: "https://shop.example/api/order" }] };
    const failure = await runAbility(
      "example.com",
      "order",
      {},
      {
        host: {
          call: async () => {
            throw error;
          },
        },
      },
    )
      .then(() => undefined)
      .catch((caught) => caught);
    assert.equal(failure.outcome.write_status, "may_have_applied");
    assert.equal(failure.outcome.code, "outcome_unknown");
    assert.equal(failure.outcome.retry, "never");
    assert.equal(failure.outcome.possible_commit, true);
    assert.doesNotMatch(failure.message, /second way ran/);
  });
});

test("a page refusal settles not applied once every write request has answered", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: {},
        ways: [
          { kind: "api", operation: "order" },
          { kind: "script", runtime: "node", code: "return 'by script';" },
        ],
      }),
    );
    const error = new Error("the click returned");
    error.receipt = {
      requests: [{ method: "POST", url: "https://shop.example/api/order", status: 422 }],
      dialog: "Invalid coupon",
    };
    const answer = await runAbility(
      "example.com",
      "order",
      {},
      {
        host: {
          call: async () => {
            throw error;
          },
        },
      },
    );
    assert.equal(answer.result, "by script");
    assert.equal(answer.write.write_status, "applied");
  });
});

test("a processing answer is not applied and is not retried", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: {},
        ways: [
          { kind: "api", operation: "order" },
          { kind: "script", runtime: "node", code: "return 'second way ran';" },
        ],
      }),
    );
    const failure = await runAbility(
      "example.com",
      "order",
      {},
      {
        host: {
          call: async () => ({
            ok: true,
            receipt: {
              processing: true,
              requests: [{ method: "POST", url: "https://shop.example/api/order", status: 202 }],
            },
          }),
        },
      },
    )
      .then(() => undefined)
      .catch((caught) => caught);
    assert.equal(failure.outcome.code, "outcome_unknown");
    assert.equal(failure.outcome.retry, "never");
    assert.equal(failure.outcome.write_status, "may_have_applied");
    assert.doesNotMatch(failure.message, /second way ran/);
  });
});

test("a read whose site ignored a filter fails as input_not_applied", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "flights",
        inputs: { type: "object", properties: { max: { type: "number" } } },
        ways: [{ kind: "api", operation: "flights", params: { max: "{{inputs.max}}" } }],
        options: { checks: [{ input: "max", field: "price", op: "lte" }] },
      }),
    );
    const host = { call: async () => [{ price: "$250" }, { price: "$900" }] };
    await assert.rejects(
      runAbility("example.com", "flights", { max: 300 }, { host }),
      /INPUT_NOT_APPLIED.*"retry":"same_key"/,
    );
    const ok = await runAbility("example.com", "flights", {}, { host });
    assert.equal(ok.result.length, 2, "no input, no check");
  });
});

test("saving refuses unused inputs and weakened contracts", async () => {
  await withHome(async () => {
    await assert.rejects(
      saveAbility(ability({ inputs: { type: "object", properties: { sort: {} } } })),
      /ABILITY_INPUT_UNUSED: search declares sort/,
    );
    await saveAbility(
      ability({
        name: "sorted",
        inputs: {
          type: "object",
          properties: { sort: { description: "By design: the site has one order" } },
        },
      }),
    );
    const saved = await saveAbility(
      ability({ outputs: { type: "object", properties: { title: {}, price: {} } } }),
    );
    assert.ok(saved.warnings.some((warning) => warning.includes("no test cases")));
    await assert.rejects(
      saveAbility(ability({ outputs: { type: "object", properties: { title: {} } } })),
      /ABILITY_CONTRACT_WEAKENED: search: output price removed/,
    );
    await saveAbility(ability({ outputs: { type: "object", properties: { title: {} } } }), {
      breaking: true,
    });
  });
});

test("test cases catch an ability whose output ignores its inputs", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        tests: [{ inputs: { q: "tea" } }, { inputs: { q: "coffee" } }],
      }),
    );
    const constant = await testAbility("example.com", "search", {
      host: { call: async () => [{ title: "$0" }] },
    });
    assert.equal(constant.constant, true);
    assert.equal(constant.ok, false);
    const honest = await testAbility("example.com", "search", {
      host: { call: async (_operation, params) => [{ title: params.q }] },
    });
    assert.equal(honest.ok, true);
  });
});

test("a node script's browser.fetch answers in browser code's shape", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ path: request.url, method: request.method }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/books`;
  try {
    await withHome(async () => {
      await saveAbility(
        ability({
          name: "fetcher",
          inputs: { type: "object", properties: { url: { type: "string" } } },
          ways: [
            {
              kind: "script",
              runtime: "node",
              code: "const a = await browser.fetch(inputs.url); const b = await browser.fetch(inputs.url, {as: 'text'}); return {status: a.status, ok: a.ok, json: a.json, text: typeof b.text};",
            },
          ],
        }),
      );
      const answer = await runAbility("example.com", "fetcher", { url });
      // Objects built inside the vm sandbox carry its prototypes; compare them as JSON.
      assert.deepEqual(JSON.parse(JSON.stringify(answer.result)), {
        status: 200,
        ok: true,
        json: { path: "/books", method: "GET" },
        text: "string",
      });
    });
  } finally {
    server.close();
  }
});

test("a page-script ability runs in the shared browser when no host is given", async () => {
  await withHome(async () => {
    const { useBrowser } = await import("../dist/runtime/bridge.js");
    const cells = [];
    useBrowser({
      run: async (code) => {
        cells.push(code);
        return [{ title: "Sharp Objects", price: "47.82" }];
      },
      status: async () => ({ browsers: 1 }),
      close() {},
    });
    try {
      await saveAbility(
        ability({
          name: "find book",
          inputs: { type: "object", properties: { title: { type: "string" } } },
          ways: [
            {
              kind: "script",
              runtime: "page",
              code: "async (page, bu, inputs) => [{ title: inputs.title, price: '47.82' }]",
            },
          ],
          options: {},
        }),
        { check: false },
      );
      const run = await runAbility("example.com", "find book", { title: "Sharp Objects" });
      assert.equal(run.result[0].title, "Sharp Objects");
      assert.match(cells[0], /hostname\.endsWith\("example\.com"\)/);
      assert.match(cells[0], /browser\.openTab\("https:\/\/example\.com\/"/);
    } finally {
      useBrowser(undefined);
    }
  });
});

test("a way the host cannot run is refused up front, never half-run", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        ways: [
          {
            kind: "api",
            operation: "search",
            open: "https://example.com/",
            params: { q: "{{inputs.q}}" },
          },
          { kind: "steps", name: "search-flow" },
        ],
      }),
    );
    let calls = 0;
    const host = { call: async () => ++calls };
    await assert.rejects(
      runAbility("example.com", "search", { q: "x" }, { host }),
      (error) =>
        /ABILITY_NEEDS: .*api way \(no page-open\)/.test(error.message) &&
        /ABILITY_NEEDS: .*steps way \(no workflow\)/.test(error.message),
    );
    assert.equal(calls, 0, "the API way never ran without its page");
  });
});

test("a steps write that misses its control has not committed, so the next way runs", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: {},
        ways: [
          {
            kind: "steps",
            steps: [{ kind: "click", target: { role: "button", name: "Save" } }],
          },
          { kind: "script", runtime: "node", code: "return 'second way ran';" },
        ],
      }),
    );
    let acted = 0;
    const answer = await runAbility(
      "example.com",
      "order",
      {},
      {
        host: {
          controls: async () => [],
          act: async () => {
            acted += 1;
            return {};
          },
        },
      },
    );
    assert.equal(acted, 0, "the click never ran");
    assert.equal(answer.result, "second way ran");
    assert.equal(answer.write.write_status, "applied");
  });
});

test("a steps write that reaches its commit does not try another way", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: {},
        ways: [
          {
            kind: "steps",
            commit: 1,
            steps: [
              { kind: "click", target: { role: "button", name: "Open" } },
              { kind: "click", target: { role: "button", name: "Save" } },
            ],
          },
          { kind: "script", runtime: "node", code: "return 'second way ran';" },
        ],
      }),
    );
    const acted = [];
    const failure = await runAbility(
      "example.com",
      "order",
      {},
      {
        host: {
          controls: async () => [
            { role: "button", name: "Open" },
            { role: "button", name: "Save" },
          ],
          act: async (step) => {
            acted.push(step.target?.name);
            if (step.target?.name === "Save") throw new Error("request timed out");
            return {};
          },
        },
      },
    )
      .then(() => undefined)
      .catch((error) => error);
    assert.deepEqual(acted, ["Open", "Save"]);
    assert.equal(failure.outcome.possible_commit, true);
    assert.equal(failure.outcome.write_status, "may_have_applied");
    assert.doesNotMatch(failure.message, /second way ran/);
  });
});

test("a refusal after only settings steps falls through to the next way", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "preference",
        kind: "write",
        inputs: {},
        ways: [
          {
            kind: "steps",
            commit: 1,
            steps: [
              { kind: "click", target: { role: "button", name: "Tip" }, settings: true },
              { kind: "click", target: { role: "button", name: "Pay" } },
            ],
          },
          { kind: "script", runtime: "node", code: "return 'second way ran';" },
        ],
      }),
    );
    let calls = 0;
    const host = {
      controls: async () => [
        { role: "button", name: "Tip" },
        { role: "button", name: "Pay" },
      ],
      act: async (step) => {
        calls += 1;
        assert.equal(step.target?.name, "Tip", "only the settings step ran");
        throw new Error("request timed out");
      },
    };
    const answer = await runAbility("example.com", "preference", {}, { host, key: "k" });
    assert.equal(answer.result, "second way ran", "the next way still runs");
    assert.equal(answer.write.write_status, "applied");
    assert.deepEqual(answer.tried, [{ via: "steps", error: "request timed out" }]);
    assert.equal(calls, 1);
  });
});

test("a settings-only refusal keeps the same key reusable", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "preference",
        kind: "write",
        inputs: {},
        ways: [
          {
            kind: "api",
            commit: 1,
            operations: [
              { operation: "savePreference", settings: true },
              { operation: "placeOrder" },
            ],
          },
        ],
      }),
    );
    let calls = 0;
    const host = {
      call: async (operation) => {
        calls += 1;
        assert.equal(operation, "savePreference", "the real commit was never reached");
        throw new Error("request timed out");
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const failure = await runAbility("example.com", "preference", {}, { host, key: "k" })
        .then(() => undefined)
        .catch((error) => error);
      assert.equal(failure.outcome.write_status, "not_applied");
      assert.doesNotMatch(failure.message, /WRITE_UNCERTAIN/);
    }
    assert.equal(calls, 2, "the key was released after the settings-only refusal");
  });
});

test("a script write counts as committed only once the script starts", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: {},
        ways: [
          { kind: "script", runtime: "page", code: "return 1;" },
          { kind: "script", runtime: "node", code: "return 'second way ran';" },
        ],
      }),
    );
    const answer = await runAbility("example.com", "order", {}, { host: {} });
    assert.equal(answer.result, "second way ran");
    await saveAbility(
      ability({
        name: "charge",
        kind: "write",
        inputs: {},
        ways: [
          { kind: "script", runtime: "node", code: "throw new Error('request timed out');" },
          { kind: "script", runtime: "node", code: "return 'second way ran';" },
        ],
      }),
    );
    const failure = await runAbility("example.com", "charge", {}, { host: {} })
      .then(() => undefined)
      .catch((error) => error);
    assert.equal(failure.outcome.possible_commit, true);
    assert.doesNotMatch(failure.message, /second way ran/);
  });
});

test("two runs with the same key cannot both send", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: {},
        ways: [{ kind: "api", operation: "order" }],
      }),
    );
    let started = 0;
    let release = () => {};
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const inside = new Promise((resolve) => {
      entered = resolve;
    });
    const host = {
      call: async () => {
        started += 1;
        entered();
        await hold;
        return { ok: true };
      },
    };
    const first = runAbility("example.com", "order", {}, { host, key: "k" });
    const second = runAbility("example.com", "order", {}, { host, key: "k" });
    try {
      await inside;
      assert.equal(started, 1);
      const blocked = await second.then(() => undefined).catch((error) => error);
      assert.match(blocked.message, /WRITE_UNCERTAIN/);
      assert.equal(blocked.outcome.retry, "never");
      assert.equal(started, 1);
    } finally {
      release();
    }
    const saved = await first;
    assert.equal(saved.write.write_status, "applied");
    assert.equal(started, 1);
  });
});

test("a refused write drops its in-flight key so the same key can be sent again", async () => {
  await withHome(async () => {
    await saveAbility(
      ability({
        name: "order",
        kind: "write",
        inputs: {},
        ways: [{ kind: "api", operation: "order" }],
      }),
    );
    let calls = 0;
    const host = {
      call: async () => {
        calls += 1;
        if (calls === 1) throw new Error("HTTP 422 invalid size");
        return { ok: true };
      },
    };
    const failure = await runAbility("example.com", "order", {}, { host, key: "k" })
      .then(() => undefined)
      .catch((error) => error);
    assert.equal(failure.outcome.write_status, "not_applied");
    assert.equal(calls, 1);
    const again = await runAbility("example.com", "order", {}, { host, key: "k" });
    assert.equal(again.write.write_status, "applied");
    assert.equal(calls, 2);
  });
});
