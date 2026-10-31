import assert from "node:assert/strict";
import test from "node:test";
import {
  mappedNotice,
  noteFetchStatus,
  resetFetchGuard,
} from "../dist/native-browser-fetch-guard.js";

test("the third not-found address on one site stops a chat from guessing", () => {
  resetFetchGuard();
  const miss = (path) => noteFetchStatus("c1", `https://letterboxd.com${path}`, 404, false);
  miss("/film/x/friends/");
  miss("/film/x/reviews/friends/");
  assert.throws(
    () => miss("/film/x/friends/reviews/"),
    /^Error: URL_GUESSING: 3 addresses on letterboxd.com/,
  );
  // Other chats, other sites, found pages and deliberate checks are not counted.
  noteFetchStatus("c2", "https://letterboxd.com/a", 404, false);
  noteFetchStatus("c1", "https://www.example.com/a", 404, false);
  noteFetchStatus("c1", "https://letterboxd.com/film/x/", 200, false);
  noteFetchStatus("c1", "https://letterboxd.com/maybe", 404, true);
});

test("the first fetch to a mapped site lists its operations, once per chat", async () => {
  resetFetchGuard();
  const asked = [];
  const operations = async (site) => {
    asked.push(site);
    return [
      { id: "search", what: "Search films" },
      { id: "rate", what: "Rate", writes: true },
    ];
  };
  const notice = await mappedNotice("c1", "https://www.letterboxd.com/film/x/", operations);
  assert.equal(notice.site, "letterboxd.com");
  assert.deepEqual(notice.operations, [
    { id: "search", what: "Search films" },
    { id: "rate", what: "Rate", writes: true },
  ]);
  assert.match(notice.use, /siteMapper\.call\('letterboxd\.com', id, params\)/);
  assert.equal(await mappedNotice("c1", "https://letterboxd.com/other", operations), undefined);
  assert.deepEqual(asked, ["letterboxd.com"]);
});

test("an unmapped site, or a host that cannot answer, adds nothing", async () => {
  resetFetchGuard();
  const missing = async () => {
    throw new Error("NOT_MAPPED: x is not mapped yet");
  };
  assert.equal(await mappedNotice("c1", "https://x.com/", missing), undefined);
  assert.equal(await mappedNotice("c1", "https://y.com/", async () => []), undefined);
});
