import assert from "node:assert/strict";
import test from "node:test";
import { detectChallenge } from "../dist/index.js";

const answer = (status, headers = {}, text = "") => ({ status, headers, text });

test("bot walls are named, not reported as a broken API", () => {
  assert.deepEqual(detectChallenge(answer(403, { "cf-mitigated": "challenge" })), {
    vendor: "cloudflare",
    evidence: "cf-mitigated: challenge",
  });
  assert.equal(
    detectChallenge(answer(403, {}, "<title>Just a moment...</title>"))?.vendor,
    "cloudflare",
  );
  assert.equal(
    detectChallenge(answer(429, {}, '<script src="https://geo.captcha-delivery.com/x"></script>'))
      ?.vendor,
    "datadome",
  );
  assert.equal(
    detectChallenge(answer(403, {}, "<div id='px-captcha'></div>"))?.vendor,
    "perimeterx",
  );
  assert.equal(
    detectChallenge(answer(403, {}, "Access Denied\n\nReference #18.abc123"))?.vendor,
    "akamai",
  );
  assert.equal(
    detectChallenge(answer(503, {}, "Checking your browser before accessing"))?.vendor,
    "unknown",
  );
});

test("a normal answer is never a wall", () => {
  assert.equal(detectChallenge(answer(200, {}, '{"title":"Just a moment..."}')), undefined);
  assert.equal(detectChallenge(answer(200, {}, "<p>Say hello to every human here</p>")), undefined);
  assert.equal(detectChallenge(answer(500, {}, "Internal Server Error")), undefined);
  assert.equal(detectChallenge(answer(404, {}, "Not Found")), undefined);
  assert.equal(detectChallenge(answer(418, {}, "I am a teapot")), undefined);
});

test("a 200 check page is a wall, and a title change alone is not", async () => {
  const wall = "<title>Just a moment...</title><p>Checking your browser</p>";
  assert.equal(detectChallenge(answer(200, {}, wall))?.vendor, "cloudflare");
  const { pageSnapshot } = await import("../dist/challenge.js");
  const shop = `<title>Shop</title><p>Just a moment... ${"lamp ".repeat(80)}</p>`;
  const renamed = shop.replace("<title>Shop</title>", "<title>Store</title>");
  assert.equal(detectChallenge(answer(200, {}, renamed), pageSnapshot(shop)), undefined);
});

test("a wall thrown from a call is its own kind, not a broken API", async () => {
  const { Challenged, errorKind } = await import("../dist/index.js");
  const error = new Challenged(
    "getStreams",
    { status: 403, headers: {} },
    {
      vendor: "cloudflare",
      evidence: "cf-mitigated: challenge",
    },
  );
  assert.equal(errorKind(error), "challenged");
  assert.match(error.message, /cloudflare bot wall/);
  assert.match(error.message, /nothing to repair/);
});
