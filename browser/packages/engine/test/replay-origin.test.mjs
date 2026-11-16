import assert from "node:assert/strict";
import test from "node:test";
import { errorOwner, leadingCode } from "@browserkit/protocol";
import {
  browserDataApi,
  replayHeaders,
  replayOriginRefusal,
  replayUrlRefusal,
} from "../dist/code-api-data.js";

test("a replay that would leave its origin names both and is refused before it is sent", () => {
  const moved = replayOriginRefusal(
    "r_12",
    "https://shop.example/api/cart",
    "https://shop.example/cart",
    "https://other.example",
  );
  assert.match(
    moved,
    /REPLAY_ORIGIN: r_12 was sent from https:\/\/shop\.example, the tab is on https:\/\/other\.example; go https:\/\/shop\.example first/,
  );
  assert.match(moved, /Next: await page\.goto\("https:\/\/shop\.example\/"\)/);
  assert.equal(leadingCode(moved), "REPLAY_ORIGIN");
  assert.equal(errorOwner("REPLAY_ORIGIN"), "model");

  const cross = replayOriginRefusal(
    "r_9",
    "https://api.shop.example/v1/items",
    "https://shop.example/list",
    "https://news.example",
  );
  assert.match(cross, /sent from https:\/\/shop\.example to https:\/\/api\.shop\.example/);
  assert.match(cross, /the tab is on https:\/\/news\.example/);
  assert.match(cross, /go https:\/\/shop\.example first/);

  assert.equal(
    replayOriginRefusal(
      "r_1",
      "https://shop.example/api",
      "https://shop.example/cart",
      "https://shop.example",
    ),
    undefined,
  );
  assert.equal(
    replayOriginRefusal(
      "r_2",
      "https://api.shop.example/v1",
      "https://shop.example/list",
      "https://shop.example",
    ),
    undefined,
    "the page that sent a cross-origin call can replay it",
  );

  const blank = replayOriginRefusal(
    "r_3",
    "https://shop.example/api",
    "https://shop.example/",
    "null",
  );
  assert.match(blank, /the tab is on a page with an opaque origin/);
  assert.match(blank, /sent from https:\/\/shop\.example/);

  const fromBlank = replayOriginRefusal(
    "r_4",
    "https://shop.example/api",
    "about:blank",
    "https://other.example",
  );
  assert.match(
    fromBlank,
    /sent from a page with an opaque origin \(such as about:blank\) to https:\/\/shop\.example/,
  );
  assert.match(fromBlank, /go https:\/\/shop\.example first/);

  const replay = browserDataApi.slice(browserDataApi.indexOf("replay: async"));
  const refusalAt = replay.indexOf("replayOriginRefusal");
  const sendAt = replay.indexOf("inspect(__pageRequest");
  assert.ok(
    refusalAt > 0 && sendAt > refusalAt,
    "the refusal is raised before the request is sent",
  );
  assert.match(replay, /redirect: 'manual'/);
  assert.doesNotMatch(replay, /redirect: 'follow'/);
});

test("replay refuses another origin or a mapped address while the tab is still on the sending page", () => {
  const mapped = replayUrlRefusal(
    "r_1",
    "http://[::ffff:169.254.169.254]/latest/meta-data",
    "https://shop.example/cart",
  );
  assert.match(mapped, /REPLAY_ORIGIN: r_1 would leave https:\/\/shop\.example/);
  assert.match(mapped, /::ffff:a9fe:a9fe|169\.254\.169\.254/);
  assert.match(mapped, /the request was not sent/);
  assert.match(mapped, /Next: await page\.goto\("https:\/\/shop\.example\/"\)/);
  const bank = replayUrlRefusal(
    "r_1",
    "https://bank.example/transfer?to=attacker",
    "https://shop.example/cart",
  );
  assert.match(bank, /would leave https:\/\/shop\.example for https:\/\/bank\.example/);
  assert.equal(
    replayUrlRefusal(
      "r_2",
      "https://shop.example/api/cart?fresh=1",
      "https://shop.example/api/cart",
    ),
    undefined,
  );
  assert.equal(
    replayUrlRefusal("r_3", "http://127.0.0.1:4010/cart", "http://127.0.0.1:4010/cart"),
    undefined,
  );
  const headers = {
    authorization: "Bearer secret-auth-token",
    "x-api-key": "secret-api-key",
    "content-type": "application/json",
    cookie: "sid=secret-cookie-value",
  };
  assert.equal(replayHeaders(headers, false)["x-api-key"], "secret-api-key");
  assert.equal(replayHeaders(headers, true)["x-api-key"], undefined);
  assert.equal(replayHeaders(headers, true).authorization, undefined);
  assert.equal(replayHeaders(headers, true).cookie, undefined);
  assert.equal(replayHeaders(headers, true)["content-type"], "application/json");
});
