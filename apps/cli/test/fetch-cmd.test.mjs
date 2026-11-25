// aeon fetch: curl-style flags, body to stdout, receipt to stderr, redacted headers, exit codes.
// The browser is a stub, so nothing here opens Chrome.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchCell, parseFetchArgs, runFetch } from "../dist/fetch-cmd.js";

const URL_ = "https://substack.com/api/v1/inbox";

function harness(
  response = { status: 200, headers: { "content-type": "application/json" }, text: '{"ok":true}' },
) {
  const calls = [];
  const io = { stdout: "", stderr: "" };
  let clock = 0;
  const deps = {
    run: async (code, options) => {
      calls.push({ code, options });
      clock += 300;
      if (response instanceof Error) throw response;
      return response;
    },
    stdout: (text) => (io.stdout += text),
    stderr: (text) => (io.stderr += text),
    now: () => clock,
  };
  return { calls, io, deps };
}

test("parses curl flags, repeatable headers and defaults", async () => {
  const options = await parseFetchArgs([
    "-X",
    "put",
    "-H",
    "Accept: application/json",
    "--header",
    "X-Test: a: b",
    "-d",
    "x=1",
    "-i",
    "-f",
    "-o",
    "out.txt",
    "-q",
    "--page",
    "--browser",
    "Work",
    "--timeout",
    "5000",
    URL_,
  ]);
  assert.equal(options.method, "PUT");
  assert.deepEqual(options.headers, { Accept: "application/json", "X-Test": "a: b" });
  assert.equal(options.body, "x=1");
  assert.equal(options.include && options.fail && options.quiet && options.page, true);
  assert.equal(options.output, "out.txt");
  assert.equal(options.browser, "Work");
  assert.equal(options.timeoutMs, 5000);
  const plain = await parseFetchArgs([URL_]);
  assert.equal(plain.method, "GET");
  assert.equal(plain.timeoutMs, 30000);
  assert.equal((await parseFetchArgs(["-h"])).help, true);
  assert.equal((await parseFetchArgs(["--help"])).help, true);
});

test("a body without -X makes a POST; --json sets the content type and is validated", async () => {
  assert.equal((await parseFetchArgs(["-d", "a", URL_])).method, "POST");
  const json = await parseFetchArgs(["--json", '{"a":1}', URL_]);
  assert.equal(json.method, "POST");
  assert.equal(json.body, '{"a":1}');
  assert.equal(json.headers["Content-Type"], "application/json");
  const kept = await parseFetchArgs(["-H", "content-type: text/x", "--json", "1", URL_]);
  assert.deepEqual(kept.headers, { "content-type": "text/x" });
  await assert.rejects(parseFetchArgs(["--json", "{bad", URL_]), /not valid JSON/);
});

test("-d @file reads the body from the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aeon-fetch-"));
  try {
    const file = join(dir, "body.txt");
    await writeFile(file, "from file");
    assert.equal((await parseFetchArgs(["-d", `@${file}`, URL_])).body, "from file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("body to stdout, receipt to stderr, -q silences the receipt", async () => {
  const { io, deps, calls } = harness();
  assert.equal(await runFetch([URL_], deps), 0);
  assert.equal(io.stdout, '{"ok":true}');
  assert.equal(io.stderr, "200 · 0.3 s · via Chrome\n");
  assert.match(calls[0].code, /browser\.fetch\(/);
  assert.doesNotMatch(calls[0].code, /debugger/);
  const quiet = harness();
  await runFetch(["-q", URL_], quiet.deps);
  assert.equal(quiet.io.stderr, "");
});

test("-i prints status and headers with auth values redacted", async () => {
  const { io, deps } = harness({
    status: 200,
    statusText: "OK",
    headers: {
      "content-type": "text/plain",
      "set-cookie": "sid=secret",
      authorization: "Bearer secret",
      "x-csrf-token": "secret",
      "x-xsrf-token": "secret",
      "proxy-authorization": "secret",
    },
    text: "hi",
  });
  await runFetch(["-i", URL_], deps);
  assert.match(io.stdout, /^HTTP 200 OK\n/);
  assert.match(io.stdout, /content-type: text\/plain/);
  assert.match(io.stdout, /set-cookie: \[redacted\]/);
  assert.match(io.stdout, /authorization: \[redacted\]/);
  assert.match(io.stdout, /x-csrf-token: \[redacted\]/);
  assert.doesNotMatch(io.stdout, /secret/);
  assert.match(io.stdout, /\n\nhi$/);
});

test("-f exits non-zero on 404 and 500; without it the body still prints and exits 0", async () => {
  for (const status of [404, 500]) {
    const failing = harness({ status, headers: {}, text: "nope" });
    assert.notEqual(await runFetch(["-f", URL_], failing.deps), 0);
    const plain = harness({ status, headers: {}, text: "nope" });
    assert.equal(await runFetch([URL_], plain.deps), 0);
    assert.equal(plain.io.stdout, "nope");
  }
});

test("-o writes the body to a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aeon-fetch-"));
  try {
    const file = join(dir, "out.json");
    const { io, deps } = harness();
    assert.equal(await runFetch(["-o", file, URL_], deps), 0);
    assert.equal(await readFile(file, "utf8"), '{"ok":true}');
    assert.equal(io.stdout, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-http URLs are refused before the browser", async () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
    const { io, deps, calls } = harness();
    assert.notEqual(await runFetch([url], deps), 0);
    assert.equal(calls.length, 0);
    assert.notEqual(io.stderr, "");
  }
});

test("--page sends page.request from a tab of the origin; --browser and timeout reach the cell", async () => {
  const { deps, calls } = harness();
  await runFetch(["--page", "--browser", "Work", "--timeout", "1000", URL_], deps);
  assert.match(calls[0].code, /page\.request\(/);
  assert.match(calls[0].code, /browser\.tabs\(\)/);
  assert.equal(calls[0].options.browser, "Work");
  assert.equal(calls[0].options.timeoutMs, 6000);
  assert.match(fetchCell(await parseFetchArgs([URL_])), /timeoutMs: 30000/);
});

test("a failed cell exits non-zero with its message", async () => {
  const { io, deps } = harness(new Error("PRIVATE_NETWORK: 10.0.0.1"));
  assert.equal(await runFetch([URL_], deps), 1);
  assert.match(io.stderr, /PRIVATE_NETWORK/);
});
