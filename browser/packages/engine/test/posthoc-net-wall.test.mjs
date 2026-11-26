// Post-hoc network, wall and feed claws: the GraphQL census and replay, the wall detector and the
// declared-feed reader, run in a vm sandbox against a fake page and recording: no Chrome, no model.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const load = (name) => import(pathToFileURL(path.join(dist, name)).href);
const { browserPosthocNetApi } = await load("code-api-posthoc-net.js");
const { wallDetect } = await load("native-browser-wall.js");
const { feedLinksOf, feedParse } = await load("native-browser-feeds.js");
const { gqlOpsOf } = await load("native-browser-graphql.js");

const plain = (value) => JSON.parse(JSON.stringify(value));

function sandbox() {
  const logs = [];
  const context = vm.createContext({
    console: { log: (line) => logs.push(line), warn: (line) => logs.push(line) },
    setTimeout,
    URL,
    __helpTopics: {},
  });
  vm.runInContext(browserPosthocNetApi, context);
  return { context, logs };
}

// A fake page: a recording (entries with request and response bodies), page facts and requests.
function fakePage(context, { entries = [], bodies = {}, facts, links = [], url, answers = {} }) {
  const sent = [];
  const calls = { evaluate: 0, inspect: 0 };
  const base = {
    network: {
      list: async () =>
        entries.map(({ id, method, url, type, status, requestBody }) => ({
          id,
          method,
          url,
          type,
          status,
          requestBody,
        })),
      body: async (id) => bodies[id],
      get: async (id) => entries.find((entry) => entry.id === id),
    },
    evaluate: async () => {
      calls.evaluate += 1;
      throw new Error("evaluate records an action; the wall and feed readers use inspect");
    },
    inspect: async (fn) => {
      calls.inspect += 1;
      if (fn === context.wallFacts) return facts;
      if (fn === context.feedLinkFacts) return links;
      return url;
    },
    replay: async (id, changes) => {
      sent.push({ id, ...changes });
      return { status: 200, json: answers.replay };
    },
    request: async (href) => {
      sent.push({ href });
      const answer = answers[href];
      if (!answer) return { status: 404 };
      return typeof answer === "string"
        ? { status: 200, text: answer }
        : { status: 200, json: answer };
    },
    summary: async () => ({ url, title: facts && facts.title }),
    feed: { collect: async () => ({ items: [], stopped: "end" }) },
  };
  return { page: context.__extendPagePosthocNet({ tabId: 1 }, base), sent, calls };
}

const twitchBody = JSON.stringify([
  {
    operationName: "PlaybackAccessToken",
    variables: { login: "x", token: "abc" },
    extensions: { persistedQuery: { version: 1, sha256Hash: "a".repeat(64) } },
  },
  {
    operationName: "ChannelShell",
    variables: { login: "x" },
    extensions: { persistedQuery: { version: 1, sha256Hash: "b".repeat(64) } },
  },
]);
const gqlEntries = [
  {
    id: "1",
    method: "POST",
    url: "https://www.goodreads.com/graphql",
    type: "Fetch",
    status: 200,
    requestBody: JSON.stringify({
      operationName: "getReviews",
      query: "query getReviews($id: ID!) { reviews(id: $id) { id } }",
      variables: { id: 7, limit: 10 },
    }),
  },
  {
    id: "2",
    method: "POST",
    url: "https://graphql.anilist.co/",
    type: "Fetch",
    status: 200,
    requestBody: JSON.stringify({
      query: "query ($id: Int) { Page: Media(id: $id) { title } }",
      variables: { id: 1 },
    }),
  },
  {
    id: "3",
    method: "POST",
    url: "https://gql.twitch.tv/gql",
    type: "Fetch",
    status: 200,
    requestBody: twitchBody,
  },
  {
    id: "4",
    method: "GET",
    type: "Fetch",
    status: 200,
    url:
      "https://www.airbnb.com/api/v3/StaysSearch/" +
      "c".repeat(64) +
      "?operationName=StaysSearch&variables=" +
      encodeURIComponent('{"query":"Paris"}'),
  },
  {
    id: "5",
    method: "POST",
    url: "https://a.test/graphql",
    type: "Fetch",
    status: 200,
    requestBody: JSON.stringify({ query: "mutation Save { save { ok } }" }),
  },
  { id: "6", method: "GET", url: "https://a.test/static/app.js", type: "Script", status: 200 },
];

test("network.graphql names standard, anonymous, batched, persisted-GET and mutation operations", async () => {
  const { context } = sandbox();
  const { page } = fakePage(context, {
    entries: gqlEntries,
    bodies: { 1: { data: { reviews: [] } }, 3: [{ data: { token: {} } }, { data: { user: {} } }] },
  });
  const ops = plain(await page.network.graphql());
  assert.deepEqual(
    ops.map((op) => [op.op, op.kind, op.batchIndex ?? null]),
    [
      ["getReviews", "query", null],
      ["Media", "query", null],
      ["PlaybackAccessToken", "persisted", 0],
      ["ChannelShell", "persisted", 1],
      ["StaysSearch", "persisted", null],
      ["Save", "mutation", null],
    ],
  );
  assert.equal(ops[2].hash, "a".repeat(64));
  assert.equal(ops[2].variables.token, "[redacted]", "secrets are scrubbed");
  assert.deepEqual(ops[0].responseKeys, ["reviews"]);
  assert.deepEqual(ops[3].responseKeys, ["user"], "batch items read their own answer");
  assert.equal(ops[4].hash, "c".repeat(64));
  assert.deepEqual(ops[4].variables, { query: "Paris" });
  assert.deepEqual(
    plain(await page.network.graphql({ op: "channelshell" })).map((op) => op.id),
    ["3"],
  );
});

test("graphql.call merges variables and keeps the query, persisted hash and batch wrapper", async () => {
  const { context } = sandbox();
  const { page, sent } = fakePage(context, {
    entries: gqlEntries,
    answers: { replay: [{ data: { user: { id: 9 } } }] },
  });
  assert.deepEqual(plain(await page.graphql.call("ChannelShell", { login: "y" })), {
    user: { id: 9 },
  });
  assert.deepEqual(plain(sent[0].json), [
    {
      operationName: "ChannelShell",
      variables: { login: "y" },
      extensions: { persistedQuery: { version: 1, sha256Hash: "b".repeat(64) } },
    },
  ]);
  await page.graphql.call("getReviews", { id: 8 });
  assert.equal(sent[1].json.query, "query getReviews($id: ID!) { reviews(id: $id) { id } }");
  assert.deepEqual(
    plain(sent[1].json.variables),
    { id: 8, limit: 10 },
    "merged into the recorded variables",
  );
  await page.graphql.call("getReviews", { id: 9 }, { replace: true });
  assert.deepEqual(plain(sent[2].json.variables), { id: 9 });
  await page.graphql.call("StaysSearch", { query: "Rome" });
  const url = new URL(sent[3].url);
  assert.match(url.pathname, /\/api\/v3\/StaysSearch\/c{64}$/);
  assert.deepEqual(JSON.parse(url.searchParams.get("variables")), { query: "Rome" });
  await assert.rejects(page.graphql.call("Nope"), /NOT_FOUND/);
});

test("gqlOpsOf reads ?operationName&extensions persisted GETs", () => {
  const url =
    "https://a.test/graphql?operationName=Feed&variables=%7B%22n%22%3A1%7D&extensions=" +
    encodeURIComponent(JSON.stringify({ persistedQuery: { sha256Hash: "d".repeat(64) } }));
  assert.deepEqual(plain(gqlOpsOf({ id: "9", method: "GET", url, status: 200 })), [
    {
      id: "9",
      url,
      method: "GET",
      status: 200,
      op: "Feed",
      kind: "persisted",
      hash: "d".repeat(64),
      variables: { n: 1 },
    },
  ]);
});

const facts = (over = {}) => ({
  url: "https://site.test/",
  title: "Home",
  text: "x".repeat(5000),
  textLength: 5000,
  markers: [],
  password: false,
  ...over,
});
const doc = (status, url = "https://site.test/") => ({
  url,
  type: "Document",
  status,
  method: "GET",
});

test("wall: Cloudflare Turnstile, Vercel 708, Reddit network security and HN rate-limit", () => {
  const cf = wallDetect(
    facts({
      title: "Just a moment...",
      text: "Verify you are human",
      textLength: 20,
      markers: ["cloudflare"],
    }),
    [doc(403)],
  );
  assert.equal(cf.blocked, true);
  assert.equal(cf.kind, "cloudflare");
  assert.equal(cf.status, 403);
  const vercel = wallDetect(facts({ title: "", text: "", textLength: 0 }), [
    doc(200),
    {
      url: "https://site.test/.well-known/vercel/security/request-challenge",
      type: "Fetch",
      method: "POST",
      status: 708,
    },
  ]);
  assert.equal(vercel.kind, "vercel");
  assert.match(vercel.signal, /request-challenge 708/);
  const reddit = wallDetect(
    facts({ title: "Blocked", text: "You've been blocked by network security.", textLength: 60 }),
    [doc(403)],
  );
  assert.deepEqual([reddit.blocked, reddit.kind, reddit.status], [true, "waf", 403]);
  const hn = wallDetect(
    facts({
      title: "",
      text: "Sorry, we're not able to serve your requests this quickly.",
      textLength: 58,
    }),
    [doc(503)],
  );
  assert.deepEqual([hn.blocked, hn.kind, hn.status], [true, "rate-limit", 503]);
});

test("wall: a partial wall on /csi/ or /graphql, a sign-in wall, and a healthy page", () => {
  const partial = wallDetect(facts(), [
    doc(200),
    { url: "https://site.test/csi/film/x/rating", type: "Other", status: 403 },
    { url: "https://site.test/graphql", type: "Fetch", status: 403 },
    { url: "https://ads.test/pixel.gif", type: "Image", status: 403 },
  ]);
  assert.equal(partial.blocked, false);
  assert.deepEqual(
    plain(partial.partial).map((row) => row.url),
    ["https://site.test/csi/film/x/rating", "https://site.test/graphql"],
  );
  assert.match(partial.signal, /partial: \/csi\/film\/x\/rating 403/);
  const login = wallDetect(
    facts({
      url: "https://site.test/login?next=/",
      text: "Sign in",
      textLength: 7,
      password: true,
    }),
    [doc(200, "https://site.test/login?next=/")],
  );
  assert.equal(login.kind, "login");
  assert.deepEqual(plain(wallDetect(facts(), [doc(200)])), {
    blocked: false,
    kind: null,
    status: 200,
    signal: null,
    partial: [],
  });
});

test("summary and an empty feed.collect carry the wall instead of a silent empty result", async () => {
  const { context } = sandbox();
  const { page } = fakePage(context, {
    url: "https://site.test/",
    facts: facts({ title: "Just a moment...", markers: ["cloudflare"] }),
    entries: [{ id: "1", ...doc(403) }],
  });
  const summary = plain(await page.summary());
  assert.equal(summary.blocked, true);
  assert.equal(summary.wall.kind, "cloudflare");
  const feed = plain(await page.feed.collect());
  assert.equal(feed.wall.kind, "cloudflare");
  const healthy = fakePage(sandbox().context, {
    url: "https://site.test/",
    facts: facts(),
    entries: [{ id: "1", ...doc(200) }],
  });
  assert.equal((await healthy.page.summary()).wall, undefined);
  assert.ok(
    context.__helpTopics.wall && context.__helpTopics.graphql && context.__helpTopics.feeds,
  );
});

const rss = `<?xml version="1.0"?><rss><channel><title>Hacker News</title><item><title>A &amp; B</title><link>https://news.test/1</link><pubDate>Mon, 1 Jan 2026</pubDate></item><item><title><![CDATA[Second]]></title><link>https://news.test/2</link></item></channel></rss>`;
const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Games</title><entry><title>Game 1</title><link rel="alternate" href="https://chess.test/g/1"/><updated>2026-01-01</updated></entry></feed>`;

test("feeds: RSS, Atom, JSON Feed and oEmbed links, parsed, with foreign feeds skipped", async () => {
  const { context } = sandbox();
  const { page, sent } = fakePage(context, {
    url: "https://www.site.test/watch?v=1",
    links: [
      { rel: "alternate", type: "application/rss+xml", href: "/rss", title: "RSS" },
      {
        rel: "alternate",
        type: "application/atom+xml",
        href: "https://www.site.test/feed.atom",
        title: "",
      },
      { rel: "alternate", type: "application/feed+json", href: "feed.json", title: "" },
      {
        rel: "alternate",
        type: "application/json+oembed",
        href: "https://site.test/oembed?url=x",
        title: "",
      },
      { rel: "alternate", type: "application/rss+xml", href: "https://evil.test/rss", title: "" },
      { rel: "stylesheet", type: "text/css", href: "/a.css", title: "" },
    ],
    answers: {
      "https://www.site.test/rss": rss,
      "https://www.site.test/feed.atom": atom,
      "https://www.site.test/feed.json": {
        title: "J",
        items: [{ title: "j1", url: "https://www.site.test/j1", date_published: "2026" }],
      },
      "https://site.test/oembed?url=x": {
        type: "video",
        title: "Clip",
        author_name: "Me",
        provider_name: "Site",
        html: "<iframe>",
      },
    },
  });
  const feeds = plain(await page.feeds());
  assert.deepEqual(
    feeds.map((feed) => feed.type),
    ["rss", "atom", "json", "oembed", "rss"],
  );
  assert.deepEqual(feeds[0].items, [
    { title: "A & B", link: "https://news.test/1", date: "Mon, 1 Jan 2026" },
    { title: "Second", link: "https://news.test/2" },
  ]);
  assert.equal(feeds[0].title, "Hacker News");
  assert.deepEqual(feeds[1].items, [
    { title: "Game 1", link: "https://chess.test/g/1", date: "2026-01-01" },
  ]);
  assert.deepEqual(feeds[2].items, [
    { title: "j1", link: "https://www.site.test/j1", date: "2026" },
  ]);
  assert.deepEqual(feeds[3].sample, {
    type: "video",
    title: "Clip",
    author_name: "Me",
    provider_name: "Site",
  });
  assert.equal(feeds[4].skipped, "not same-origin");
  assert.ok(
    !sent.some((call) => String(call.href).includes("evil.test")),
    "a foreign feed is never fetched",
  );
});

test("feed helpers: oEmbed on another site is refused, XML oEmbed and the 64 KB cap", () => {
  const links = feedLinksOf(
    [{ rel: "alternate", type: "text/xml+oembed", href: "https://other.test/oembed" }],
    "https://site.test/",
  );
  assert.equal(links[0].allowed, false);
  assert.deepEqual(plain(feedParse("oembed", "<oembed><title>T</title></oembed>")), {
    title: "T",
    sample: { title: "T" },
  });
  const big = "<rss>" + "<item><title>x</title></item>".repeat(5000) + "</rss>";
  assert.equal(feedParse("rss", big, 3).items.length, 3);
});

test("wall and feeds read the page with inspect, never evaluate (no recorded action)", async () => {
  const { context, logs } = sandbox();
  const { page, calls } = fakePage(context, {
    url: "https://site.test/",
    facts: facts(),
    entries: [],
    links: [],
  });
  await page.wall();
  await page.feeds();
  await page.summary();
  assert.equal(calls.evaluate, 0);
  assert.ok(calls.inspect >= 3);
  assert.deepEqual(logs, [], "a healthy page prints nothing");
});
