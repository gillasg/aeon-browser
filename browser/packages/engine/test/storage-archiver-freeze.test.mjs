import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { makeClaws, clawDomains, runClaw } from "../dist/native-browser-claws.js";
import { scrubValue, scrubUrl } from "../dist/native-browser-claw-port.js";
import { keyRange } from "../dist/native-browser-storage-db.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk";

// A fake tab: answers CDP commands from `answers`, records every call, and pushes events.
function fakePort(answers = {}) {
  const sent = [];
  const listeners = new Set();
  return {
    sent,
    methods: () => sent.map(([method]) => method),
    emit: (method, params) => {
      for (const listener of [...listeners]) listener(method, params);
    },
    listenerCount: () => listeners.size,
    send: async (method, params = {}) => {
      sent.push([method, params]);
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(params) : (answer ?? {});
    },
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
const evaluateWith = (fn) => (params) => ({ result: { value: fn(params.expression) } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("idle claws send nothing and enable no domain", async () => {
  const port = fakePort();
  const claws = makeClaws(port);
  assert.deepEqual(clawDomains(claws), []);
  assert.equal(port.sent.length, 0);
  assert.equal(port.listenerCount(), 0);
  assert.deepEqual(await runClaw(claws, { claws: "freeze.list" }), []);
  assert.deepEqual(await runClaw(claws, { claws: "downloads.list" }), []);
  await runClaw(claws, { claws: "dryRun.stop" });
  await runClaw(claws, { claws: "db.stop" });
  await runClaw(claws, { claws: "downloads.stop" });
  assert.equal(port.sent.length, 0, "stopping idle claws sends nothing");
  await assert.rejects(runClaw(claws, { claws: "nope" }), /INVALID_INPUT/);
});

test("scrubbing hides tokens, JWTs, passwords and keys", () => {
  const out = scrubValue({
    user: "ada",
    password: "hunter2",
    nested: { apiKey: "k-123", note: `Bearer ${JWT}` },
    list: [JWT, "plain"],
    cookie: "sid=1",
    stripe: "sk_live_ABCDEFGHIJKLMNOPQRST",
  });
  assert.equal(out.user, "ada");
  assert.equal(out.password, "[redacted]");
  assert.equal(out.nested.apiKey, "[redacted]");
  assert.doesNotMatch(JSON.stringify(out), /eyJ|hunter2|sk_live/);
  assert.equal(out.list[1], "plain");
  assert.equal(
    scrubUrl("https://a.test/p?q=shoes&access_token=xyz#frag"),
    "https://a.test/p?q=shoes&access_token=[redacted]",
  );
});

test("IndexedDB reads enable the domain lazily, scrub values and disable on stop", async () => {
  const port = fakePort({
    "Runtime.evaluate": evaluateWith(() => "https://app.test"),
    "IndexedDB.requestDatabaseNames": { databaseNames: ["app"] },
    "IndexedDB.requestDatabase": {
      databaseWithObjectStores: {
        version: 3,
        objectStores: [
          { name: "users", keyPath: "id", autoIncrement: false, indexes: [{ name: "byEmail" }] },
        ],
      },
    },
    "IndexedDB.requestData": {
      objectStoreDataEntries: [
        { primaryKey: { type: "number", value: 1 }, value: { type: "object", objectId: "o1" } },
      ],
      hasMore: true,
    },
    "Runtime.callFunctionOn": {
      result: { value: { id: 1, name: "Ada", authToken: JWT, bio: `key ${JWT}` } },
    },
  });
  const claws = makeClaws(port);
  const dbs = await runClaw(claws, { claws: "db.databases" });
  assert.deepEqual(dbs, [
    {
      name: "app",
      version: 3,
      stores: [{ name: "users", keyPath: "id", autoIncrement: false, indexes: ["byEmail"] }],
    },
  ]);
  assert.deepEqual(clawDomains(claws), ["IndexedDB"]);
  const read = await runClaw(claws, {
    claws: "db.read",
    db: "app",
    store: "users",
    options: { limit: 5, keyRange: { lower: 1, upper: 9 } },
  });
  assert.equal(read.hasMore, true);
  assert.equal(read.rows[0].key, 1);
  assert.equal(read.rows[0].value.name, "Ada");
  assert.equal(read.rows[0].value.authToken, "[redacted]");
  assert.doesNotMatch(JSON.stringify(read), /eyJ/);
  const request = port.sent.find(([m]) => m === "IndexedDB.requestData")[1];
  assert.equal(request.pageSize, 5);
  assert.deepEqual(request.keyRange, keyRange({ lower: 1, upper: 9 }));
  assert.ok(port.methods().includes("Runtime.releaseObject"));
  assert.equal(port.methods().filter((m) => m === "IndexedDB.enable").length, 1);
  await runClaw(claws, { claws: "db.stop" });
  assert.ok(port.methods().includes("IndexedDB.disable"));
  assert.deepEqual(clawDomains(claws), []);
});

test("Cache Storage lists caches and entries without enabling anything", async () => {
  const port = fakePort({
    "Runtime.evaluate": evaluateWith(() => "https://app.test"),
    "CacheStorage.requestCacheNames": { caches: [{ cacheId: "c1", cacheName: "v1" }] },
    "CacheStorage.requestEntries": {
      cacheDataEntries: [
        {
          requestURL: "https://app.test/api?token=abc",
          requestMethod: "GET",
          responseStatus: 200,
          responseHeaders: [
            { name: "set-cookie", value: "sid=secret" },
            { name: "content-type", value: "text/html" },
          ],
        },
      ],
      returnCount: 1,
    },
  });
  const claws = makeClaws(port);
  assert.deepEqual(await runClaw(claws, { claws: "db.caches" }), [{ name: "v1", id: "c1" }]);
  const entries = await runClaw(claws, {
    claws: "db.cacheEntries",
    cache: "v1",
    options: { limit: 2 },
  });
  assert.equal(entries.entries[0].headers["set-cookie"], "[redacted]");
  assert.equal(entries.entries[0].headers["content-type"], "text/html");
  assert.doesNotMatch(entries.entries[0].url, /abc/);
  assert.deepEqual(clawDomains(claws), []);
  await assert.rejects(
    runClaw(claws, { claws: "db.cacheEntries", cache: "nope" }),
    /TARGET_NOT_FOUND/,
  );
});

test("DOMStorage watch pushes filtered, scrubbed changes into a bounded ring", async () => {
  const port = fakePort();
  const claws = makeClaws(port);
  port.emit("DOMStorage.domStorageItemAdded", { key: "early", newValue: "x" });
  await runClaw(claws, { claws: "db.watch", filter: { storage: "local" } });
  assert.deepEqual(clawDomains(claws), ["DOMStorage"]);
  const local = { securityOrigin: "https://app.test", isLocalStorage: true };
  port.emit("DOMStorage.domStorageItemAdded", { storageId: local, key: "theme", newValue: "dark" });
  port.emit("DOMStorage.domStorageItemUpdated", {
    storageId: local,
    key: "auth_token",
    oldValue: "a",
    newValue: "b",
  });
  port.emit("DOMStorage.domStorageItemUpdated", {
    storageId: local,
    key: "note",
    oldValue: "x",
    newValue: JWT,
  });
  port.emit("DOMStorage.domStorageItemRemoved", { storageId: local, key: "theme" });
  port.emit("DOMStorage.domStorageItemAdded", {
    storageId: { securityOrigin: "https://app.test", isLocalStorage: false },
    key: "skipped",
    newValue: "1",
  });
  for (let i = 0; i < 300; i++)
    port.emit("DOMStorage.domStorageItemAdded", { storageId: local, key: `k${i}`, newValue: "v" });
  const { changes, dropped } = await runClaw(claws, { claws: "db.changes" });
  assert.equal(changes.length, 200, "ring is bounded");
  assert.equal(dropped, 104);
  assert.ok(changes.every((c) => c.storage === "local"));
  await runClaw(claws, { claws: "db.unwatch" });
  assert.ok(port.methods().includes("DOMStorage.disable"));
  assert.equal(port.listenerCount(), 0);
  assert.deepEqual(clawDomains(claws), []);

  // A fresh watch sees each kind, scrubbed.
  const port2 = fakePort();
  const claws2 = makeClaws(port2);
  await runClaw(claws2, { claws: "db.watch" });
  port2.emit("DOMStorage.domStorageItemAdded", {
    storageId: local,
    key: "theme",
    newValue: "dark",
  });
  port2.emit("DOMStorage.domStorageItemUpdated", {
    storageId: local,
    key: "auth_token",
    oldValue: "a",
    newValue: "b",
  });
  port2.emit("DOMStorage.domStorageItemUpdated", {
    storageId: local,
    key: "note",
    oldValue: "x",
    newValue: JWT,
  });
  port2.emit("DOMStorage.domStorageItemRemoved", { storageId: local, key: "theme" });
  const seen = (await runClaw(claws2, { claws: "db.changes", options: { clear: true } })).changes;
  assert.deepEqual(
    seen.map((c) => c.kind),
    ["added", "updated", "updated", "removed"],
  );
  assert.equal(seen[0].value, "dark");
  assert.equal(seen[1].value, "[redacted]");
  assert.equal(seen[1].oldValue, "[redacted]");
  assert.equal(seen[2].value, "[redacted]");
  assert.equal((await runClaw(claws2, { claws: "db.changes" })).changes.length, 0);
  claws2.db.detached();
  assert.equal(port2.listenerCount(), 0, "a detach drops the listener");
  assert.deepEqual(clawDomains(claws2), []);
});

test("downloads track willBegin to completed or canceled and stop cleanly", async () => {
  const port = fakePort();
  const claws = makeClaws(port);
  await assert.rejects(runClaw(claws, { claws: "downloads.waitFor" }), /start\(\) first/);
  await runClaw(claws, { claws: "downloads.start", options: { downloadPath: "/tmp/dl" } });
  assert.deepEqual(port.sent[0], [
    "Browser.setDownloadBehavior",
    { behavior: "allowAndName", downloadPath: "/tmp/dl", eventsEnabled: true },
  ]);
  const waiting = runClaw(claws, {
    claws: "downloads.waitFor",
    filter: { filename: "report" },
    timeoutMs: 5000,
  });
  port.emit("Browser.downloadWillBegin", {
    guid: "g1",
    url: "https://app.test/r.csv?token=s3cret",
    suggestedFilename: "report.csv",
  });
  let [item] = await runClaw(claws, { claws: "downloads.list" });
  assert.equal(item.state, "willBegin");
  assert.equal(item.localPath, "/tmp/dl/g1");
  assert.doesNotMatch(item.url, /s3cret/);
  port.emit("Browser.downloadProgress", {
    guid: "g1",
    state: "inProgress",
    totalBytes: 100,
    receivedBytes: 40,
  });
  [item] = await runClaw(claws, { claws: "downloads.list" });
  assert.equal(item.state, "inProgress");
  assert.equal(item.receivedBytes, 40);
  port.emit("Browser.downloadProgress", {
    guid: "g1",
    state: "completed",
    totalBytes: 100,
    receivedBytes: 100,
  });
  const done = await waiting;
  assert.equal(done.state, "completed");
  assert.equal(done.receivedBytes, 100);
  port.emit("Page.downloadWillBegin", {
    guid: "g2",
    url: "https://app.test/b.zip",
    suggestedFilename: "b.zip",
  });
  port.emit("Page.downloadProgress", { guid: "g2", state: "canceled" });
  const canceled = await runClaw(claws, { claws: "downloads.list", filter: { state: "canceled" } });
  assert.deepEqual(
    canceled.map((d) => d.guid),
    ["g2"],
  );
  await assert.rejects(
    runClaw(claws, { claws: "downloads.waitFor", filter: { filename: "never" }, timeoutMs: 20 }),
    /TIMEOUT/,
  );
  await runClaw(claws, { claws: "downloads.stop" });
  assert.deepEqual(port.sent.at(-1), [
    "Browser.setDownloadBehavior",
    { behavior: "default", eventsEnabled: false },
  ]);
  assert.equal(port.listenerCount(), 0);
  assert.deepEqual(clawDomains(claws), []);
});

test("PDF and MHTML receipts carry a sha256 digest and scrubbed metadata", async () => {
  const pdf = Buffer.from("%PDF-1.7 fake");
  const mhtml = "From: <Saved by Blink>\r\nContent-Type: multipart/related";
  const port = fakePort({
    "Runtime.evaluate": evaluateWith(() => ({
      url: "https://app.test/order?session=abc&id=7",
      title: `Order ${JWT}`,
    })),
    "Page.printToPDF": { data: pdf.toString("base64") },
    "Page.captureSnapshot": { data: mhtml },
  });
  const claws = makeClaws(port);
  const receipt = await runClaw(claws, {
    claws: "archive.pdf",
    options: { landscape: true, evil: 1 },
  });
  assert.equal(receipt.kind, "pdf");
  assert.equal(receipt.mime, "application/pdf");
  assert.equal(receipt.bytes, pdf.length);
  assert.equal(receipt.sha256, createHash("sha256").update(pdf).digest("hex"));
  assert.equal(receipt.base64, undefined);
  assert.doesNotMatch(JSON.stringify(receipt), /abc|eyJ/);
  assert.match(receipt.url, /id=7/);
  const params = port.sent.find(([m]) => m === "Page.printToPDF")[1];
  assert.deepEqual(params, { printBackground: true, landscape: true });
  const snap = await runClaw(claws, { claws: "archive.mhtml", options: { base64: true } });
  assert.equal(snap.mime, "multipart/related");
  assert.equal(snap.sha256, createHash("sha256").update(mhtml).digest("hex"));
  assert.equal(Buffer.from(snap.base64, "base64").toString(), mhtml);
  assert.deepEqual(port.sent.find(([m]) => m === "Page.captureSnapshot")[1], { format: "mhtml" });
});

function freezeTab() {
  const page = {
    url: "https://app.test/cart",
    origin: "https://app.test",
    title: "Cart",
    scrollX: 0,
    scrollY: 420,
    local: [
      ["cart", "[1,2]"],
      ["auth_token", JWT],
    ],
    session: [["step", "2"]],
    forms: [
      { selector: "#qty", value: "3" },
      { selector: "#gift", checked: true },
    ],
  };
  let cookies = [
    {
      name: "sid",
      value: "s-secret",
      domain: "app.test",
      path: "/",
      session: true,
      secure: true,
      httpOnly: true,
    },
  ];
  let restored;
  const port = fakePort({
    "Runtime.evaluate": evaluateWith((expression) => {
      if (expression.startsWith("(function readPageState") || expression.includes("readPageState"))
        return page;
      if (expression.includes("writePageState")) {
        restored = JSON.parse(expression.slice(expression.lastIndexOf(")(") + 2, -1));
        return { restored: true, forms: restored.forms.length };
      }
      if (expression.includes("readyState")) return true;
      if (expression === "location.href") return page.url;
      return undefined;
    }),
    "Network.getCookies": () => ({ cookies }),
    "Network.setCookies": (params) => {
      cookies = params.cookies;
      return {};
    },
    "Network.deleteCookies": (params) => {
      cookies = cookies.filter((c) => c.name !== params.name);
      return {};
    },
  });
  return {
    port,
    page,
    setCookies: (next) => (cookies = next),
    cookies: () => cookies,
    restored: () => restored,
  };
}

test("freeze snapshots summarize without secrets and restore cookies, storage and forms", async () => {
  const tab = freezeTab();
  const claws = makeClaws(tab.port);
  const summary = await runClaw(claws, { claws: "freeze.snapshot", label: "before checkout" });
  assert.equal(summary.id, "snap-1");
  assert.equal(summary.label, "before checkout");
  assert.deepEqual(summary.counts, { localStorage: 2, sessionStorage: 1, cookies: 1, forms: 2 });
  assert.deepEqual(summary.scroll, { x: 0, y: 420 });
  const text = JSON.stringify([summary, await runClaw(claws, { claws: "freeze.list" })]);
  assert.doesNotMatch(text, /eyJ|s-secret|\[1,2\]/);
  assert.deepEqual(tab.port.sent.find(([m]) => m === "Network.getCookies")[1], {
    urls: ["https://app.test/cart"],
  });

  // The page moves on: a new cookie, then the user navigates away.
  tab.setCookies([
    ...tab.cookies(),
    { name: "order", value: "placed", domain: "app.test", path: "/" },
  ]);
  tab.page.url = "https://app.test/done";
  const back = await runClaw(claws, { claws: "freeze.restore", id: "snap-1" });
  assert.equal(back.restored.navigated, true);
  assert.equal(back.restored.forms, 2);
  assert.deepEqual(tab.port.sent.find(([m]) => m === "Page.navigate")[1], {
    url: "https://app.test/cart",
  });
  assert.deepEqual(
    tab.cookies().map((c) => c.name),
    ["sid"],
  );
  assert.equal(tab.restored().scrollY, 420);
  assert.deepEqual(tab.restored().local[0], ["cart", "[1,2]"]);
  assert.doesNotMatch(JSON.stringify(back), /eyJ|s-secret/);
  assert.deepEqual(clawDomains(claws), []);

  assert.deepEqual(await runClaw(claws, { claws: "freeze.drop", id: "snap-1" }), { dropped: true });
  await assert.rejects(
    runClaw(claws, { claws: "freeze.restore", id: "snap-1" }),
    /TARGET_NOT_FOUND/,
  );
  await runClaw(claws, { claws: "freeze.snapshot" });
  assert.deepEqual(await runClaw(claws, { claws: "freeze.clear" }), { cleared: 1 });
});

test("dry-run shield fakes POST/DELETE, passes GET through and records scrubbed receipts", async () => {
  const port = fakePort();
  const claws = makeClaws(port);
  await assert.rejects(
    runClaw(claws, { claws: "dryRun.start" }, () => true),
    /already records/,
  );
  assert.equal(port.sent.length, 0);
  await runClaw(claws, { claws: "dryRun.start" });
  assert.deepEqual(clawDomains(claws), ["Fetch"]);
  assert.equal(port.sent[0][0], "Fetch.enable");
  const paused = (requestId, method, url, extra = {}) =>
    port.emit("Fetch.requestPaused", {
      requestId,
      request: {
        method,
        url,
        headers: { Authorization: `Bearer ${JWT}`, Accept: "*/*" },
        ...extra,
      },
    });
  paused("r1", "POST", "https://app.test/api/order", {
    postData: JSON.stringify({ item: 7, password: "hunter2" }),
  });
  paused("r2", "GET", "https://app.test/api/order/7");
  paused("r3", "DELETE", "https://app.test/api/order/7?api_key=zzz");
  await tick();
  const answers = port.sent.slice(1).map(([m, p]) => [m, p.requestId]);
  assert.deepEqual(answers, [
    ["Fetch.fulfillRequest", "r1"],
    ["Fetch.continueRequest", "r2"],
    ["Fetch.fulfillRequest", "r3"],
  ]);
  const fulfilled = port.sent.find(([m]) => m === "Fetch.fulfillRequest")[1];
  assert.equal(fulfilled.responseCode, 200);
  assert.deepEqual(JSON.parse(Buffer.from(fulfilled.body, "base64").toString()), { dryRun: true });
  const { receipts, passedThrough } = await runClaw(claws, { claws: "dryRun.list" });
  assert.equal(passedThrough, 1);
  assert.deepEqual(
    receipts.map((r) => r.method),
    ["POST", "DELETE"],
  );
  assert.equal(receipts[0].headers.Authorization, "[redacted]");
  assert.equal(receipts[0].headers.Accept, "*/*");
  assert.match(receipts[0].bodyPreview, /"item":7/);
  assert.doesNotMatch(JSON.stringify(receipts), /hunter2|eyJ|zzz/);

  // Fail mode with a URL filter: matching writes are aborted, others continue.
  await runClaw(claws, {
    claws: "dryRun.start",
    options: { mode: "fail", url: "/api/pay", methods: ["post"] },
  });
  paused("r4", "POST", "https://app.test/api/pay");
  paused("r5", "POST", "https://app.test/api/log");
  await tick();
  assert.deepEqual(
    port.sent.slice(-2).map(([m, p]) => [m, p.requestId]),
    [
      ["Fetch.failRequest", "r4"],
      ["Fetch.continueRequest", "r5"],
    ],
  );
  assert.equal(
    port.methods().filter((m) => m === "Fetch.enable").length,
    1,
    "restart reuses interception",
  );

  const stopped = await runClaw(claws, { claws: "dryRun.stop" });
  assert.equal(stopped.active, false);
  assert.equal(stopped.receipts.length, 3);
  assert.equal(port.sent.at(-1)[0], "Fetch.disable");
  assert.equal(port.listenerCount(), 0);
  assert.deepEqual(clawDomains(claws), []);
  const before = port.sent.length;
  paused("r6", "POST", "https://app.test/api/order");
  await tick();
  assert.equal(port.sent.length, before, "nothing is intercepted after stop");
});
