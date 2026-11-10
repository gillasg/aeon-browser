import assert from "node:assert/strict";
import test from "node:test";
import { HELP_TOPICS } from "../dist/code-api-help.js";
import { historyCall } from "../dist/native-browser-history.js";

const DAY = 86_400_000;
const NOV1 = Date.parse("2026-11-01T00:00:00.000Z");
const NOV30 = Date.parse("2026-11-30T23:00:00.000Z");
const DEC1 = Date.parse("2026-12-01T00:00:00.000Z");
const OCT = Date.parse("2026-10-02T00:00:00.000Z");
const VISIT_CAP = 4000;

function page(url, title, lastVisitTime, visitCount) {
  return { id: url, url, title, lastVisitTime, visitCount };
}

function visits(...times) {
  return times.map((visitTime) => ({ visitTime }));
}

function fake(items, byUrl = {}) {
  const calls = { search: [], visits: [] };
  const api = {
    async search(query) {
      calls.search.push(query);
      return items;
    },
    async getVisits({ url }) {
      calls.visits.push(url);
      return byUrl[url] ?? [];
    },
  };
  return { api, calls };
}

function iso(time) {
  return new Date(time).toISOString();
}

test("search and top keep all-time totals when since and until are omitted", async () => {
  const early = page("https://a.example/old", "Old", 2_000, 10);
  const late = page("https://a.example/new", "New", 9_000, 3);
  const other = page("https://b.example/", "Other", 8_000, 4);
  const history = fake([early, late, other], {
    [early.url]: visits(1),
  });
  const found = await historyCall("search", { text: "a", days: 7, max: 20 }, history.api);
  assert.deepEqual(
    found,
    [early, late, other].map((item) => ({
      url: item.url,
      title: item.title,
      lastVisit: iso(item.lastVisitTime),
      visits: item.visitCount,
    })),
  );
  assert.equal(history.calls.visits.length, 0);
  const query = history.calls.search[0];
  assert.equal(query.text, "a");
  assert.equal(query.maxResults, 20);
  assert.equal(query.endTime, undefined);
  assert.ok(Math.abs(query.startTime - (Date.now() - 7 * DAY)) < 5_000);

  const ranked = await historyCall("top", { days: 90 }, history.api);
  assert.equal(history.calls.visits.length, 0);
  assert.deepEqual(ranked, {
    by: "site",
    scanned: 3,
    groups: [
      {
        key: "a.example",
        visits: 13,
        pages: 2,
        lastVisit: iso(9_000),
        top: { url: early.url, title: "Old" },
      },
      {
        key: "b.example",
        visits: 4,
        pages: 1,
        lastVisit: iso(8_000),
        top: { url: other.url, title: "Other" },
      },
    ],
  });
});

test("since and until count visits inside the window and return their times", async () => {
  const often = page("https://docs.example/guide", "Guide", DEC1, 1);
  const rare = page("https://news.example/once", "Once", DEC1, 50);
  const history = fake([often, rare], {
    [often.url]: visits(NOV1, NOV1 + DAY, NOV30),
    [rare.url]: visits(OCT, NOV1 + 5_000, DEC1),
  });
  const found = await historyCall(
    "search",
    { since: "2026-11-01", until: "2026-11-30" },
    history.api,
  );
  assert.deepEqual(found, [
    {
      url: often.url,
      title: "Guide",
      lastVisit: iso(NOV30),
      visits: 3,
      times: [iso(NOV30), iso(NOV1 + DAY), iso(NOV1)],
    },
    {
      url: rare.url,
      title: "Once",
      lastVisit: iso(NOV1 + 5_000),
      visits: 1,
      times: [iso(NOV1 + 5_000)],
    },
  ]);
  assert.deepEqual(history.calls.search[0].startTime, NOV1);
  assert.deepEqual(history.calls.search[0].endTime, DEC1);
  assert.deepEqual(history.calls.visits, [often.url, rare.url]);
});

test("top ranks a date span by in-window visits, not all-time totals", async () => {
  const often = page("https://docs.example/guide", "Guide", DEC1, 1);
  const rare = page("https://news.example/once", "Once", DEC1, 50);
  const rust = page("https://www.reddit.com/r/rust", "Rust", NOV1, 2);
  const post = page("https://reddit.com/r/rust/comments/1", "Post", NOV30, 9);
  const history = fake([often, rare, rust, post], {
    [often.url]: visits(NOV1, NOV1 + DAY, NOV30),
    [rare.url]: visits(OCT, NOV1 + 5_000, DEC1),
    [rust.url]: visits(NOV1),
    [post.url]: visits(NOV1 + 10, NOV30, OCT, DEC1),
  });
  const ranked = await historyCall(
    "top",
    { by: "site", since: NOV1, until: "2026-11-30T23:00:00.000Z" },
    history.api,
  );
  assert.equal(ranked.truncated, undefined);
  assert.deepEqual(
    ranked.groups.map((group) => ({ key: group.key, visits: group.visits, pages: group.pages })),
    [
      { key: "docs.example", visits: 3, pages: 1 },
      { key: "reddit.com", visits: 3, pages: 2 },
      { key: "news.example", visits: 1, pages: 1 },
    ],
  );
  const reddit = ranked.groups.find((group) => group.key === "reddit.com");
  assert.equal(reddit.lastVisit, iso(NOV30));
  assert.deepEqual(reddit.top, { url: post.url, title: "Post" });
  assert.deepEqual(reddit.times, [iso(NOV30), iso(NOV1 + 10), iso(NOV1)]);

  const sections = await historyCall(
    "top",
    { by: "path", since: "2026-11-01", until: "2026-11-30", match: "rust" },
    history.api,
  );
  assert.deepEqual(
    sections.groups.map((group) => group.key),
    ["reddit.com/r/rust"],
  );
  assert.equal(sections.groups[0].visits, 3);
});

test("a windowed search pages with before and drops pages that have no visit in range", async () => {
  const kept = page("https://kept.example/", "Kept", 8_000, 4);
  const gone = page("https://gone.example/", "Gone", 9_000, 9);
  const again = page("https://kept.example/", "Kept", 8_000, 4);
  const history = fake([kept, again, gone], {
    [kept.url]: visits(1_000, 5_000),
    [gone.url]: visits(6_000),
  });
  const found = await historyCall("search", { since: 0, until: 9_000, before: 5_000 }, history.api);
  assert.deepEqual(found, [
    { url: kept.url, title: "Kept", lastVisit: iso(1_000), visits: 1, times: [iso(1_000)] },
  ]);
  assert.deepEqual(history.calls.visits, [kept.url, gone.url]);
  assert.equal(history.calls.search[0].endTime, 4_999);
});

test("visit times are capped and an unreadable bound is refused", async () => {
  const url = "https://many.example/";
  const times = Array.from({ length: 101 }, (_, index) => 1_700_000_000_000 + index * 1000);
  const history = fake([page(url, "Many", times.at(-1), 101)], {
    [url]: visits(...times),
  });
  const found = await historyCall("search", { since: times[0], until: times.at(-1) }, history.api);
  assert.equal(found[0].visits, 101);
  assert.equal(found[0].times.length, 100);
  assert.equal(found[0].times[0], iso(times.at(-1)));
  assert.equal(found[0].timesTruncated, true);
  await assert.rejects(
    () => historyCall("search", { since: "not-a-date" }, history.api),
    /INVALID_HISTORY: since/,
  );
  await assert.rejects(
    () => historyCall("top", { until: "yesterday" }, history.api),
    /INVALID_HISTORY: until/,
  );
  const empty = fake([]);
  assert.deepEqual(await historyCall("search", { since: DEC1, until: NOV1 }, empty.api), []);
  assert.equal(empty.calls.search.length, 0);
  assert.deepEqual(
    await historyCall("top", { since: "2026-12-01", until: "2026-11-01" }, empty.api),
    {
      by: "site",
      scanned: 0,
      groups: [],
    },
  );
});

test("top stops counting after the visit cap and says the rank is truncated", async () => {
  const items = [];
  const byUrl = {};
  for (let index = 0; index < VISIT_CAP + 1; index += 1) {
    const url = `https://cap.example/${index}`;
    items.push(page(url, String(index), NOV1 + index, 99));
    byUrl[url] = visits(NOV1 + index);
  }
  const history = fake(items, byUrl);
  const ranked = await historyCall(
    "top",
    { since: "2026-11-01", until: "2026-11-30" },
    history.api,
  );
  assert.equal(ranked.truncated, true);
  assert.equal(history.calls.visits.length, VISIT_CAP);
  assert.equal(
    ranked.groups.reduce((sum, group) => sum + group.visits, 0),
    VISIT_CAP,
  );
  assert.equal(
    ranked.groups.some((group) => group.key === "cap.example" && group.visits === 99),
    false,
  );
});

test("recent sort uses the latest in-window visit, and a millisecond since is accepted", async () => {
  const older = page("https://older.example/", "Older", NOV30, 1);
  const newer = page("https://newer.example/", "Newer", NOV1, 1);
  const history = fake([older, newer], {
    [older.url]: visits(NOV1, NOV1 + DAY, NOV1 + 2 * DAY),
    [newer.url]: visits(NOV30),
  });
  const recent = await historyCall(
    "top",
    { since: String(NOV1), until: NOV30, sort: "recent" },
    history.api,
  );
  assert.deepEqual(
    recent.groups.map((group) => group.key),
    ["newer.example", "older.example"],
  );
  const byVisits = await historyCall("top", { since: String(NOV1), until: NOV30 }, history.api);
  assert.deepEqual(
    byVisits.groups.map((group) => group.key),
    ["older.example", "newer.example"],
  );
});

test("before still pages an all-time search, and date-only expansion does not apply to it", async () => {
  const history = fake([page("https://a.example/", "A", NOV1, 2)]);
  await historyCall("search", { before: "2026-11-01T00:00:00.000Z" }, history.api);
  assert.equal(history.calls.visits.length, 0);
  assert.equal(history.calls.search[0].endTime, NOV1 - 1);
  assert.ok(Math.abs(history.calls.search[0].startTime - (Date.now() - 30 * DAY)) < 5_000);
});

test("help(history) tells the agent when visits are all-time and when they are in a window", () => {
  const text = HELP_TOPICS.history;
  assert.match(text, /since/);
  assert.match(text, /until/);
  assert.match(text, /all-time counts per page/);
  assert.match(text, /times/);
  assert.match(text, /YYYY-MM-DD/);
  assert.match(text, /4000 pages/);
});
