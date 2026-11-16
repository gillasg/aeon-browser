import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { classifyFailure } from "../dist/ability-writes.js";
import { DirectTransport, PageTransport } from "../dist/index.js";
import { pageCallExpression } from "../dist/runtime/transports.js";
import {
  connectionAddress,
  preflightHost,
  privateAddress,
  privateTarget,
} from "@browserkit/protocol";
import { followRedirects, hopRefusal, reachOf } from "../dist/runtime/net-guard.js";
import { pinnedRequest, rejectPin } from "../dist/runtime/pinned-request.js";
import { FakeBrowser } from "./fake-browser.mjs";

// A hostile page (or a mapped operation it planted) redirects a cookie-bearing call at another
// origin or at a private address. The guard must not connect there, and must say where it tried
// to go. A loopback dev site keeps working.

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function originOf(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function requestOf(url, method, body) {
  return {
    operationId: "call",
    origin: new URL(url).origin,
    method,
    url,
    headers: {},
    ...(body === undefined ? {} : { body }),
  };
}

async function refused(run) {
  await assert.rejects(run, (error) => {
    assert.match(error.message, /not followed|PRIVATE_NETWORK/);
    return true;
  });
}

test("a loopback dev site follows a same-site redirect and answers", async () => {
  const hits = [];
  const site = await listen((req, res) => {
    hits.push(req.url);
    if (req.url === "/old") {
      res.writeHead(302, { location: "/new" });
      res.end();
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const origin = originOf(site);
    const direct = new DirectTransport();
    const response = await direct.send(requestOf(`${origin}/old`, "GET"), {
      auth: [],
      home: `${origin}/`,
    });
    assert.equal(response.json.ok, true);
    assert.deepEqual(hits, ["/old", "/new"]);
  } finally {
    site.close();
  }
});

test("a write's cross-site redirect is not followed and names the target", async () => {
  const stolen = [];
  const sink = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      stolen.push({ url: req.url, body: Buffer.concat(chunks).toString() });
      res.end("stolen");
    });
  });
  const site = await listen((req, res) => {
    if (req.url === "/move") {
      res.writeHead(307, { location: `${originOf(sink)}/capture` });
      res.end();
      return;
    }
    res.end("ok");
  });
  try {
    const origin = originOf(site);
    const direct = new DirectTransport();
    let message = "";
    await assert.rejects(
      () =>
        direct.send(requestOf(`${origin}/move`, "POST", "coupon=secret"), {
          auth: [],
          home: `${origin}/`,
        }),
      (error) => {
        message = error.message;
        assert.match(message, /not followed/);
        assert.match(message, /\/capture/);
        return true;
      },
    );
    assert.equal(stolen.length, 0, "the other origin must not receive the write");
    const outcome = classifyFailure(new Error(message), true);
    assert.equal(outcome.code, "outcome_unknown");
    assert.equal(outcome.write_status, "may_have_applied");
    assert.equal(outcome.retry, "never");
  } finally {
    site.close();
    sink.close();
  }
});

test("a redirect to a private or metadata address is refused and names the host", async () => {
  let metadataHits = 0;
  const site = await listen((req, res) => {
    if (req.url === "/rebind") {
      res.writeHead(302, { location: "http://169.254.169.254/latest" });
      res.end();
      return;
    }
    if (req.url === "/loop") {
      res.writeHead(302, { location: "http://127.0.0.1:9/stolen" });
      res.end();
      return;
    }
    metadataHits += 1;
    res.end("ok");
  });
  try {
    const origin = originOf(site);
    const direct = new DirectTransport();
    await assert.rejects(
      () => direct.send(requestOf(`${origin}/rebind`, "GET"), { auth: [], home: `${origin}/` }),
      (error) => {
        assert.match(error.message, /169\.254\.169\.254/);
        assert.match(error.message, /not followed/);
        return true;
      },
    );
    await refused(() =>
      direct.send(requestOf("http://127.0.0.1:9/stolen", "GET"), {
        auth: [],
        home: "https://shop.example/",
      }),
    );
    const loopback = await hopRefusal("http://169.254.169.254/latest", reachOf(`${origin}/`));
    assert.match(loopback ?? "", /169\.254\.169\.254/);
    const rebound = await hopRefusal("http://shop.test/latest", "public", async () => [
      "169.254.169.254",
    ]);
    assert.match(rebound ?? "", /169\.254\.169\.254/);
    assert.equal(await hopRefusal(`${origin}/ok`, "loopback"), undefined);
    assert.equal(metadataHits, 0);
  } finally {
    site.close();
  }
});

test("the page fetch does not follow a redirect to another origin or a private address", async () => {
  const stolen = [];
  const sink = await listen((req, res) => {
    stolen.push(req.url);
    res.end("stolen");
  });
  const site = await listen((req, res) => {
    if (req.url === "/move") {
      res.writeHead(307, { location: `${originOf(sink)}/capture` });
      res.end();
      return;
    }
    if (req.url === "/rebind") {
      res.writeHead(302, { location: "http://169.254.169.254/latest" });
      res.end();
      return;
    }
    res.end("<html></html>");
  });
  try {
    const origin = originOf(site);
    const browser = new FakeBrowser();
    const page = new PageTransport(async () => browser);
    const home = `${origin}/`;
    await assert.rejects(
      () => page.send(requestOf(`${origin}/move`, "POST", "coupon=secret"), { auth: [], home }),
      (error) => {
        assert.match(error.message, /not followed/);
        assert.match(error.message, /\/capture/);
        return true;
      },
    );
    await assert.rejects(
      () => page.send(requestOf(`${origin}/rebind`, "GET"), { auth: [], home }),
      (error) => {
        assert.match(error.message, /169\.254\.169\.254/);
        assert.match(error.message, /not followed/);
        return true;
      },
    );
    assert.equal(stolen.length, 0);
    const kept = await page.send(requestOf(`${origin}/`, "GET"), { auth: [], home });
    assert.match(kept.text ?? "", /html/);
  } finally {
    site.close();
    sink.close();
  }
});

test("mapped and unspecified addresses are refused before a connection", async () => {
  const mapped = new URL("http://[::ffff:169.254.169.254]/latest/meta-data").hostname.replace(
    /^\[|\]$/g,
    "",
  );
  assert.equal(mapped, "::ffff:a9fe:a9fe");
  assert.ok(privateAddress(mapped));
  assert.ok(privateTarget(`http://[${mapped}]/`));
  assert.ok(await hopRefusal(`http://[${mapped}]/`, "public"));
  assert.equal(privateAddress("::"), "private address ::");
  assert.ok(privateTarget("http://[::]/"));
  assert.ok(await hopRefusal("http://[::]/", "public"));
  assert.ok(await hopRefusal("http://[::ffff:7f00:1]/", "public"));
  assert.ok(await hopRefusal("http://[::ffff:0:0]/", "public"));
  assert.ok(await hopRefusal("http://[64:ff9b::a9fe:a9fe]/", "public"));
  assert.equal(preflightHost("http://127.0.0.1:3000/", [3000]), "allow");
  assert.equal(preflightHost("https://example.com/"), "resolve");
  assert.match(preflightHost("http://[::]/"), /private/);
  assert.match(preflightHost("http://[::ffff:7f00:1]/"), /private/);
  const hits = [];
  const server = await listen((req, res) => {
    hits.push(req.url);
    res.end("secret");
  });
  const port = server.address().port;
  try {
    await assert.rejects(
      () =>
        followRedirects({
          url: `http://[::ffff:7f00:1]:${port}/meta`,
          method: "GET",
          home: "https://shop.example/",
          request: async () => {
            hits.push("sent");
            return { status: 200, headers: {}, text: "secret" };
          },
        }),
      /PRIVATE_NETWORK/,
    );
    assert.deepEqual(hits, []);
  } finally {
    server.close();
  }
});

test("a name connects to the address the guard checked, with the original host", async () => {
  let seen;
  await followRedirects({
    url: "http://shop.test/latest",
    method: "GET",
    home: "https://shop.example/",
    resolve: async () => ["1.2.3.4"],
    request: async (hop) => {
      seen = hop;
      return { status: 200, headers: {}, text: "ok" };
    },
  });
  assert.equal(seen.address, "1.2.3.4");
  assert.equal(seen.host, "shop.test");
  assert.equal(new URL(seen.url).hostname, "shop.test");
  assert.equal(connectionAddress("::ffff:102:304"), "1.2.3.4");
  let sent = false;
  await assert.rejects(
    () =>
      followRedirects({
        url: "http://shop.test/latest",
        method: "GET",
        home: "https://shop.example/",
        resolve: async () => ["1.2.3.4", "::ffff:a9fe:a9fe"],
        request: async () => {
          sent = true;
          return { status: 200, headers: {}, text: "ok" };
        },
      }),
    /PRIVATE_NETWORK/,
  );
  assert.equal(sent, false);
  await assert.rejects(
    () =>
      followRedirects({
        url: "http://shop.test/meta",
        method: "GET",
        home: "https://shop.example/",
        resolve: async () => ["::ffff:a9fe:a9fe"],
        request: async () => {
          sent = true;
          return { status: 200, headers: {}, text: "ok" };
        },
      }),
    /PRIVATE_NETWORK/,
  );
});

test("a direct connect uses the pin and refuses a mapped address", async () => {
  const hits = [];
  const server = await listen((req, res) => {
    hits.push({ url: req.url, host: req.headers.host });
    res.end("ok");
  });
  const port = server.address().port;
  try {
    const ok = await pinnedRequest({
      url: `http://shop.test:${port}/latest`,
      method: "GET",
      headers: {},
      address: "127.0.0.1",
      host: "shop.test",
      publicReach: false,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.text, "ok");
    assert.equal(hits[0].host, `shop.test:${port}`);
    assert.equal(hits[0].url, "/latest");
    assert.equal(rejectPin("1.2.3.4", true), undefined);
    assert.ok(rejectPin("127.0.0.1", true));
    assert.equal(rejectPin("127.0.0.1", false), undefined);
    await assert.rejects(
      () =>
        pinnedRequest({
          url: `http://shop.test:${port}/meta`,
          method: "POST",
          headers: {},
          body: "sku=1",
          address: "::ffff:7f00:1",
          host: "shop.test",
          publicReach: true,
        }),
      /PRIVATE_NETWORK/,
    );
    assert.equal(hits.length, 1);
  } finally {
    server.close();
  }
});

async function answered(hop) {
  const res = await fetch(hop.url, {
    method: hop.method,
    body: hop.body,
    redirect: "manual",
  });
  const redirect = res.status >= 300 && res.status < 400;
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers),
    location: res.headers.get("location") ?? "",
    text: redirect ? "" : await res.text(),
  };
}

test("a same-site 307 does not send a write body again", async () => {
  const bodies = [];
  const server = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString() });
      if (req.url === "/order") {
        res.writeHead(307, { location: "/order/again" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("missing");
    });
  });
  const origin = originOf(server);
  try {
    await assert.rejects(
      () =>
        followRedirects({
          url: `${origin}/order`,
          method: "POST",
          body: "sku=1",
          home: `${origin}/`,
          request: answered,
        }),
      (error) => {
        assert.match(error.message, /not followed/);
        assert.match(error.message, /not sent twice/);
        assert.doesNotMatch(error.message, /PRIVATE_NETWORK/);
        const outcome = classifyFailure(error, true);
        assert.equal(outcome.write_status, "may_have_applied");
        assert.equal(outcome.possible_commit, true);
        assert.equal(outcome.retry, "never");
        return true;
      },
    );
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].body, "sku=1");
    assert.equal(bodies[0].url, "/order");
  } finally {
    server.close();
  }
});

test("a write's 301 or 302 follow-up is a GET, and a failed 303 follow-up is not a refusal", async () => {
  const bodies = [];
  const server = await listen((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString() });
      if (req.url === "/order") {
        res.writeHead(303, { location: "/order/done" });
        res.end();
        return;
      }
      if (req.url === "/item") {
        res.writeHead(req.method === "PUT" ? 302 : 301, { location: "/item/next" });
        res.end();
        return;
      }
      if (req.url === "/item/next") {
        res.end("saved");
        return;
      }
      res.writeHead(404);
      res.end("missing");
    });
  });
  const origin = originOf(server);
  try {
    await assert.rejects(
      () =>
        followRedirects({
          url: `${origin}/order`,
          method: "POST",
          body: "sku=1",
          home: `${origin}/`,
          request: answered,
        }),
      (error) => {
        assert.match(error.message, /was sent/);
        assert.match(error.message, /page\.network\.list/);
        assert.doesNotMatch(error.message, /PRIVATE_NETWORK/);
        const outcome = classifyFailure(error, true);
        assert.notEqual(outcome.write_status, "not_applied");
        assert.equal(outcome.retry, "never");
        assert.equal(outcome.possible_commit, true);
        return true;
      },
    );
    assert.equal(bodies[0].body, "sku=1");
    assert.equal(bodies[1].method, "GET");
    assert.equal(bodies[1].body, "");
    const saved = await followRedirects({
      url: `${origin}/item`,
      method: "PUT",
      body: "sku=1",
      home: `${origin}/`,
      request: answered,
    });
    assert.equal(saved.status, 200);
    const removed = await followRedirects({
      url: `${origin}/item`,
      method: "DELETE",
      body: "sku=1",
      home: `${origin}/`,
      request: answered,
    });
    assert.equal(removed.status, 200);
    const puts = bodies.filter((hit) => hit.url === "/item");
    assert.deepEqual(
      puts.map((hit) => hit.method),
      ["PUT", "DELETE"],
    );
    assert.ok(puts.every((hit) => hit.body === "sku=1"));
    const follows = bodies.filter((hit) => hit.url === "/item/next");
    assert.equal(follows.length, 2);
    assert.ok(follows.every((hit) => hit.method === "GET" && hit.body === ""));
  } finally {
    server.close();
  }
});

test("a write does not follow an https downgrade, and an upgrade drops the body", async () => {
  const resolve = async () => ["93.184.216.34"];
  const calls = [];
  await assert.rejects(
    () =>
      followRedirects({
        url: "https://shop.example/order",
        method: "POST",
        body: "sku=1",
        home: "https://shop.example/",
        resolve,
        request: async (hop) => {
          calls.push({ url: hop.url, method: hop.method, body: hop.body });
          return {
            status: 302,
            headers: {},
            location: "http://shop.example/order",
            text: "",
          };
        },
      }),
    /not followed/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, "sku=1");
  assert.equal(new URL(calls[0].url).protocol, "https:");
  const upgraded = [];
  const saved = await followRedirects({
    url: "http://shop.example/order",
    method: "POST",
    body: "sku=1",
    home: "http://shop.example/",
    resolve,
    request: async (hop) => {
      upgraded.push({ url: hop.url, method: hop.method, body: hop.body });
      if (upgraded.length === 1)
        return { status: 302, headers: {}, location: "https://shop.example/done", text: "" };
      return { status: 200, headers: {}, text: "ok" };
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(upgraded[0].body, "sku=1");
  assert.equal(upgraded[1].method, "GET");
  assert.equal(upgraded[1].body, undefined);
  assert.equal(new URL(upgraded[1].url).protocol, "https:");
});

test("an opaque browser redirect is not reported as a 302", async () => {
  const source = pageCallExpression(requestOf("https://shop.example/order", "POST", "sku=1"), {
    auth: [],
    home: "https://shop.example/",
  });
  assert.match(source, /type: 'opaqueredirect'/);
  assert.doesNotMatch(source, /opaque \? 302/);
  const hidden = { status: 0, headers: {}, type: "opaqueredirect" };
  const resolve = async () => ["93.184.216.34"];
  await assert.rejects(
    () =>
      followRedirects({
        url: "https://shop.example/order",
        method: "POST",
        body: "sku=1",
        home: "https://shop.example/",
        resolve,
        request: async () => hidden,
      }),
    (error) => {
      assert.match(error.message, /^outcome_unknown:/);
      assert.match(error.message, /was sent/);
      assert.match(error.message, /page\.network\.list/);
      assert.doesNotMatch(error.message, /HTTP 302/);
      const outcome = classifyFailure(error, true);
      assert.equal(outcome.write_status, "may_have_applied");
      assert.equal(outcome.retry, "never");
      return true;
    },
  );
  await assert.rejects(
    () =>
      followRedirects({
        url: "https://shop.example/orders",
        method: "GET",
        home: "https://shop.example/",
        resolve,
        request: async () => hidden,
      }),
    (error) => {
      assert.match(error.message, /was sent/);
      assert.match(error.message, /page\.network\.list/);
      assert.doesNotMatch(error.message, /^outcome_unknown:/);
      assert.doesNotMatch(error.message, /HTTP 302/);
      return true;
    },
  );
});

test("a private-network refusal is not a sent write", () => {
  const outcome = classifyFailure(new Error("PRIVATE_NETWORK: private address 127.0.0.1"), true);
  assert.equal(outcome.write_status, "not_attempted");
  assert.equal(outcome.possible_commit, false);
});

test("a cross-site read drops secrets, cookies, origin, and credentials", async () => {
  const seen = [];
  const sink = await listen((req, res) => {
    seen.push(req.headers);
    res.end("away");
  });
  const site = await listen((req, res) => {
    res.writeHead(302, { location: `${originOf(sink)}/away` });
    res.end();
  });
  try {
    const origin = originOf(site);
    const response = await new DirectTransport(sessionFor(origin)).send(
      secretRequest(`${origin}/start`),
      {
        auth: [],
        home: `${origin}/`,
      },
    );
    assert.equal(response.text, "away");
    assertDropped(seen[0]);
    const source = pageCallExpression(requestOf(`${origin}/start`, "GET"), {
      auth: [],
      home: `${origin}/`,
    });
    assert.match(source, /req\.crossSite \? 'omit' : 'include'/);
    assert.match(source, /withCredentials = credentials === 'include'/);
  } finally {
    site.close();
    sink.close();
  }
});

test("a same-site read keeps its secret headers and session cookie", async () => {
  const seen = [];
  const site = await listen((req, res) => {
    seen.push(req.headers);
    res.end("home");
  });
  try {
    const origin = originOf(site);
    const response = await new DirectTransport(sessionFor(origin)).send(
      secretRequest(`${origin}/stay`),
      {
        auth: [],
        home: `${origin}/`,
      },
    );
    assert.equal(response.text, "home");
    assert.equal(seen[0].authorization, "Bearer secret-auth-token");
    assert.equal(seen[0]["x-api-key"], "secret-api-key");
    assert.equal(seen[0]["x-csrf-token"], "secret-csrf-token");
    assert.equal(seen[0].cookie, "sid=secret-cookie-value");
  } finally {
    site.close();
  }
});

test("a page cross-site read does not send the tab's cookies or secret headers", async () => {
  const seen = [];
  const sink = await listen((req, res) => {
    seen.push(req.headers);
    res.end("away");
  });
  const site = await listen((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: `${originOf(sink)}/away` });
      res.end();
      return;
    }
    res.end("home");
  });
  try {
    const origin = originOf(site);
    const browser = new FakeBrowser();
    browser.cookies.set("sid", "secret-cookie-value");
    const response = await new PageTransport(async () => browser).send(
      secretRequest(`${origin}/start`),
      { auth: [], home: `${origin}/` },
    );
    assert.equal(response.text, "away");
    assertDropped(seen[0]);
  } finally {
    site.close();
    sink.close();
  }
});

function sessionFor(origin) {
  return {
    site: origin,
    savedAt: "2026-11-16T00:00:00.000Z",
    cookies: [{ name: "sid", value: "secret-cookie-value", domain: "127.0.0.1", path: "/" }],
  };
}

function secretRequest(url) {
  return {
    ...requestOf(url, "GET"),
    headers: {
      authorization: "Bearer secret-auth-token",
      "x-api-key": "secret-api-key",
      "x-csrf-token": "secret-csrf-token",
      accept: "text/plain",
    },
  };
}

function assertDropped(headers) {
  for (const name of ["authorization", "cookie", "x-api-key", "x-csrf-token", "origin", "referer"])
    assert.equal(headers[name], undefined, name);
  assert.equal(headers.accept, "text/plain");
}
