// A failure keeps its own code on the wire, with that code's hint and next step. Only a code no
// catalog knows becomes CHROME_ERROR.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { describeError, ERROR_CODES } from "@browserkit/protocol";
import { errorCode } from "../dist/native-browser-common.js";
import { sendFailure } from "../dist/native-browser-result.js";

function sent(code, detail) {
  const frames = [];
  globalThis.WebSocket ??= { OPEN: 1 };
  const socket = { readyState: WebSocket.OPEN, send: (raw) => frames.push(JSON.parse(raw)) };
  const request = { requestId: randomUUID(), operationId: randomUUID() };
  sendFailure(socket, request, code, detail);
  assert.equal(frames.length, 1);
  return frames[0];
}

test("every catalog code passes through sendFailure unchanged", () => {
  for (const code of ERROR_CODES) assert.equal(sent(code).code, code, code);
});

test("site-mapper and ability codes keep their own code, hint and next step", () => {
  for (const code of [
    "ABILITY_FAILED",
    "ABILITY_INPUT",
    "ABILITY_DRIFT",
    "SIGNED_OUT",
    "WRITE_UNCERTAIN",
    "PERSISTED_QUERY_MISS",
    "NOT_PROVEN",
    "NO_PAGINATION",
  ]) {
    const frame = sent(code, `${code}: example`);
    assert.equal(frame.code, code);
    assert.doesNotMatch(describeError(code, "example"), /Chrome refused/);
  }
  assert.equal(sent("ABILITY_INPUT").next, "await help()");
  assert.equal(
    sent("WRITE_UNCERTAIN").next,
    undefined,
    "a write that may have applied names no repeat",
  );
});

test("a thrown ability message is named by its code, not CHROME_ERROR", () => {
  assert.equal(errorCode(new Error("ABILITY_INPUT: qty is required (number)")), "ABILITY_INPUT");
  assert.equal(
    errorCode(new Error("ABILITY_FAILED: shop.example add (steps: x)")),
    "ABILITY_FAILED",
  );
  assert.equal(
    errorCode(new Error("ABILITY_UNKNOWN: shop.example has no ability x")),
    "NOT_MAPPED",
  );
  assert.equal(
    errorCode(new Error("WRITE_UNCERTAIN: shop.example add under key k")),
    "WRITE_UNCERTAIN",
  );
});

test("a narrower code goes out as its shared one; an unknown one as CHROME_ERROR", () => {
  assert.equal(sent("ACT_NOT_FOUND").code, "TARGET_NOT_FOUND");
  assert.equal(sent("SOMETHING_NEW").code, "CHROME_ERROR");
});

test("chrome:// pages get their own PROTECTED_UI hint and question", () => {
  assert.equal(errorCode(new Error("Cannot access a chrome:// URL")), "PROTECTED_UI");
  const text = describeError("PROTECTED_UI", "Cannot access a chrome:// URL");
  assert.match(text, /Chrome's own pages/);
  assert.match(
    sent("PROTECTED_UI", "Cannot access a chrome:// URL").next,
    /^ask_user: That is a Chrome settings page/,
  );
  assert.match(describeError("PROTECTED_UI", "a password manager menu"), /password manager/);
});

// Dogfooding fixes: proxy, certificate and connection failures are NETWORK, a goto stuck on the
// previous page throws TIMEOUT, a short legacy page keeps its text, a bot check is waited out.
import vm from "node:vm";
import { chromeNetErrorCode, classifyError, leadingCode } from "@browserkit/protocol";
import { browserFastApi } from "../dist/code-api-page.js";
import { browserReadApi } from "../dist/code-api-read.js";
import { CHALLENGE_PAGE_EXPRESSION } from "../dist/native-browser-challenge-page.js";

/** One function's source out of an API string, run on its own. */
function pick(api, name, context = {}) {
  const start = api.search(new RegExp(`(async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const end = api.indexOf("\n}\n", start) + 2;
  const sandbox = vm.createContext(context);
  vm.runInContext(api.slice(start, end), sandbox);
  return vm.runInContext(name, sandbox);
}

test("SOCKS, proxy and certificate failures are NETWORK with their own hint", () => {
  for (const [error, hint] of [
    ["net::ERR_SOCKS_CONNECTION_FAILED", /proxy/],
    ["net::ERR_PROXY_CONNECTION_FAILED", /proxy/],
    ["net::ERR_TUNNEL_CONNECTION_FAILED", /proxy/],
    ["net::ERR_CERT_AUTHORITY_INVALID", /certificate/],
    ["net::ERR_CERT_DATE_INVALID", /certificate/],
    ["net::ERR_NAME_NOT_RESOLVED", /could not be reached/],
  ]) {
    assert.equal(chromeNetErrorCode(error), "NETWORK", error);
    assert.equal(classifyError(new Error("navigation failed: " + error)), "NETWORK", error);
    const frame = sent("NETWORK", "navigation failed: " + error);
    assert.equal(frame.code, "NETWORK");
    const text = describeError("NETWORK", "navigation failed: " + error);
    assert.match(text, hint, text);
    assert.doesNotMatch(text, /Chrome refused/);
  }
  assert.equal(chromeNetErrorCode("net::ERR_ABORTED"), undefined);
});

test("SUBMIT_NO_EFFECT and chrome:// PROTECTED_UI keep honest codes and hints", () => {
  assert.equal(leadingCode("SUBMIT_NO_EFFECT: the form didn't react"), "SITE_BROKEN");
  assert.equal(sent("SUBMIT_NO_EFFECT", "the form didn't react").code, "SITE_BROKEN");
  const text = describeError("PROTECTED_UI", "Cannot access a chrome:// URL");
  assert.match(text, /Chrome's own pages/);
});

test("goto that timed out on the previous page throws TIMEOUT; a slow page that left does not", () => {
  const stuck = pick(browserFastApi, "__throwIfStuck");
  const old = {
    data: {
      timedOut: true,
      url: "https://a.example/index/",
      note: "still showing https://a.example/index/; retry with a longer timeout",
    },
  };
  assert.throws(
    () => stuck(old, "https://b.example/search"),
    /^Error: TIMEOUT: https:\/\/b\.example\/search did not load/,
  );
  assert.doesNotThrow(() =>
    stuck(
      {
        data: {
          timedOut: true,
          url: "https://b.example/search",
          note: "Still loading: 2 requests pending",
        },
      },
      "https://b.example/search",
    ),
  );
  assert.doesNotThrow(() =>
    stuck(
      { data: { timedOut: false, url: "https://b.example/search" } },
      "https://b.example/search",
    ),
  );
});

test("a short legacy portal keeps its navigation text instead of the stripped main part", async () => {
  const whole = {
    markdown: "Home | Archives | Search | Inventaris VOC Batavia ... ".repeat(8),
    chars: 400,
  };
  const asks = [];
  const keep = pick(browserReadApi, "__keepShortPage", {
    __compact: (fn) => String(fn),
    __readMarkdown: () => null,
    JSON,
  });
  const base = { inspect: async (source) => (asks.push(source), whole) };
  const batch = {
    probe: { bodyChars: 542 },
    markdown: { markdown: "Selamat datang di arsip", chars: 71 },
  };
  assert.equal(await keep(base, {}, batch, 40000, () => false), whole);
  assert.match(asks[0], /"mainOnly":false/);
  // A long page, a chosen selector, or a read that kept most of the text stays as read.
  assert.equal(
    await keep(base, {}, { ...batch, probe: { bodyChars: 20000 } }, 40000, () => false),
    null,
  );
  assert.equal(await keep(base, { selector: "main" }, batch, 40000, () => false), null);
  const full = { probe: { bodyChars: 100 }, markdown: { markdown: "x".repeat(90) } };
  assert.equal(await keep(base, {}, full, 40000, () => false), null);
});

test("a bot-check interstitial is recognized, so sleeps are not cut short there", () => {
  const check = (title, selectors = []) =>
    vm.runInContext(
      CHALLENGE_PAGE_EXPRESSION,
      vm.createContext({
        document: {
          title,
          querySelector: (query) => (selectors.some((s) => query.includes(s)) ? {} : null),
        },
      }),
    );
  assert.equal(check("Just a moment..."), true);
  assert.equal(check("Loading", ["#challenge-form"]), true);
  assert.equal(check("Loading", ["/cdn-cgi/challenge-platform/"]), true);
  assert.equal(check("KGB documents"), false);
});
