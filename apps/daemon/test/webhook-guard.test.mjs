// Webhooks reach public addresses only: every spelling of a private address is refused when the
// routine is saved and again when a delivery is sent, after a real or stubbed DNS lookup.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { assertWebhookResolves, parseWebhook } from "../dist/routine-fields.js";
import { sendWebhookOnce } from "../dist/routine-webhook.js";
import { resolveWebhook, webhookUrlRefusal } from "../dist/webhook-guard.js";

const PRIVATE = [
  "http://127.0.0.1/h",
  "http://localhost/h",
  "http://app.localhost/h",
  "http://printer.local/h",
  "http://db.internal/h",
  "http://[::1]/h",
  "http://[::]/h",
  "http://[::ffff:127.0.0.1]/h",
  "http://[::ffff:7f00:1]/h",
  "http://[::ffff:169.254.169.254]/latest/",
  "http://[::127.0.0.1]/h",
  "http://[64:ff9b::a9fe:a9fe]/h",
  "http://[64:ff9b::7f00:1]/h",
  "http://[fd00::1]/h",
  "http://[fe80::1]/h",
  "http://0x7f000001/h",
  "http://2130706433/h",
  "http://127.1/h",
  "http://0177.0.0.1/h",
  "http://0.0.0.0/h",
  "http://10.0.0.5/h",
  "http://172.16.0.1/h",
  "http://192.168.1.10/h",
  "http://100.64.0.1/h",
  "http://169.254.169.254/latest/meta-data/",
  "http://100.100.100.200/h",
];

test("every private, mapped, NAT64 and odd-numbered spelling is refused without a lookup", async () => {
  const lookups = [];
  const resolve = async (host) => (lookups.push(host), [{ address: "93.184.215.14", family: 4 }]);
  for (const url of PRIVATE) {
    assert.ok(webhookUrlRefusal(url), url);
    assert.throws(() => parseWebhook(url, undefined, null), /public host|http/, url);
    await assert.rejects(resolveWebhook(url, resolve), /public host/, url);
    await assert.rejects(assertWebhookResolves(url, resolve), /public host/, url);
  }
  assert.deepEqual(lookups, [], "literal addresses are judged as written");
});

test("a name that resolves to a private address is refused at save and at send", async () => {
  const stub = (address) => async () => [
    { address: "93.184.215.14", family: 4 },
    { address, family: address.includes(":") ? 6 : 4 },
  ];
  for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::ffff:7f00:1", "fd00::5"]) {
    const url = "https://hooks.example.com/h";
    assert.equal(parseWebhook(url, undefined, null).url, url, "the name alone looks public");
    await assert.rejects(assertWebhookResolves(url, stub(address)), /resolves to/, address);
    const sent = await sendWebhookOnce(
      { id: "x", url, secret: null, body: "{}", attempts: 0, nextAt: 0 },
      { resolve: stub(address) },
    );
    assert.equal(sent.delivered, false);
    assert.match(sent.error, /resolves to/, address);
  }
});

test("a public name passes, and an unresolvable one can be saved but not sent", async () => {
  const pub = async () => [{ address: "93.184.215.14", family: 4 }];
  const pinned = await resolveWebhook("https://hooks.example.com/h", pub);
  assert.equal(pinned.address, "93.184.215.14");
  const none = async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  };
  await assertWebhookResolves("https://nowhere.example/h", none);
  await assert.rejects(resolveWebhook("https://nowhere.example/h", none), /did not resolve/);
  assert.match(webhookUrlRefusal("ftp://hooks.example.com/h"), /http/);
  assert.match(webhookUrlRefusal("https://user:pw@hooks.example.com/h"), /password/);
});

test("a public-looking name whose address is a local server is never reached", async () => {
  const hits = [];
  const server = createServer((req, res) => (hits.push(req.url), res.end("ok")));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://rebind.example.com:${server.address().port}/h`;
    const sent = await sendWebhookOnce(
      { id: "x", url, secret: null, body: "{}", attempts: 0, nextAt: 0 },
      { resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
    );
    assert.equal(sent.delivered, false);
    assert.deepEqual(hits, []);
  } finally {
    server.close();
  }
});
