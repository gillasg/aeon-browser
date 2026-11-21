// A receipt for a write carries a `rewind` descriptor when the site's opposite action is known,
// and never when the write is irreversible, a read, or has no learned opposite.
import assert from "node:assert/strict";
import test from "node:test";
import {
  handleSiteMapperRequest,
  learnLive,
  navigateBackRewind,
  rewindForAbility,
  rewindForOperation,
  undoLabel,
  undoLive,
  NotProven,
} from "../dist/index.js";
import { tempHome } from "./helpers.mjs";

const SITE = "videos.example";
const PAGE = "https://videos.example/playlist?list=WL";

function entry({ method = "POST", path, status = 200, body, response, step, at = 0 }) {
  return {
    startedDateTime: new Date(Date.UTC(2026, 9, 22, 10, 0, at)).toISOString(),
    _resourceType: "fetch",
    ...(step ? { _step: step } : {}),
    request: {
      method,
      url: "https://videos.example" + path,
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "referer", value: PAGE },
      ],
      ...(body ? { postData: { mimeType: "application/json", text: JSON.stringify(body) } } : {}),
    },
    response: {
      status,
      headers: [{ name: "content-type", value: "application/json" }],
      content: { mimeType: "application/json", text: JSON.stringify(response) },
    },
  };
}

const listing = entry({
  method: "GET",
  path: "/api/playlist/WL/items",
  response: { items: [{ videoId: "v1", setVideoId: "row-111", title: "First video" }] },
  at: 1,
});
const edit = (action, label, at, status = 200) =>
  entry({
    path: "/api/playlist/edit",
    status,
    body: { playlistId: "WL", action, setVideoId: "row-111" },
    response: { status: "ok" },
    step: `click "${label}"`,
    at,
  });
const har = (...entries) => ({ log: { version: "1.2", entries } });

test("a proven write with a learned opposite carries a rewind", async (t) => {
  await tempHome(t);
  await learnLive(
    SITE,
    har(
      listing,
      edit("remove", "Remove from Watch later", 5),
      edit("add", "Add to Watch later", 6),
    ),
  );
  const rewind = await rewindForOperation(SITE, "removeFromWatchLater", { setVideoId: "row-111" });
  assert.deepEqual(rewind, {
    kind: "ability-undo",
    site: SITE,
    operation: "removeFromWatchLater",
    params: { setVideoId: "row-111" },
    label: "Undo remove from watch later",
  });
  // The same answer over the request channel the daemon uses.
  const asked = await handleSiteMapperRequest({
    siteMapper: "rewind",
    site: SITE,
    operation: "removeFromWatchLater",
  });
  assert.equal(asked.kind, "ability-undo");
  // Undo runs: it is not refused as unproven; it reaches the page (no browser in this test).
  await assert.rejects(
    undoLive(SITE, "removeFromWatchLater", { setVideoId: "row-111" }),
    (error) => !(error instanceof NotProven),
  );
});

test("a write without a learned opposite has no rewind", async (t) => {
  await tempHome(t);
  await learnLive(SITE, har(listing, edit("remove", "Remove from Watch later", 5)));
  assert.equal(await rewindForOperation(SITE, "removeFromWatchLater"), undefined);
});

test("a write the API never made has no rewind", async (t) => {
  await tempHome(t);
  await learnLive(
    SITE,
    har(
      listing,
      edit("remove", "Remove from Watch later", 5, 500),
      edit("add", "Add to Watch later", 6),
    ),
  );
  assert.equal(await rewindForOperation(SITE, "removeFromWatchLater"), undefined);
});

test("an irreversible or read ability never carries a rewind", async (t) => {
  await tempHome(t);
  const ability = (overrides) => ({
    name: "removeItem",
    site: SITE,
    kind: "write",
    inputs: {},
    ways: [{ kind: "api", operation: "removeFromWatchLater" }],
    options: {},
    stats: { runs: 0, failures: 0 },
    createdBy: "agent",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  });
  await learnLive(
    SITE,
    har(
      listing,
      edit("remove", "Remove from Watch later", 5),
      edit("add", "Add to Watch later", 6),
    ),
  );
  assert.equal((await rewindForAbility(ability({}), {}))?.kind, "ability-undo");
  assert.equal(await rewindForAbility(ability({ effect: "irreversible" })), undefined);
  assert.equal(
    await rewindForAbility(ability({ name: "payNow", description: "payment" })),
    undefined,
  );
  assert.equal(await rewindForAbility(ability({ kind: "read" })), undefined);
});

test("labels and the navigate-back descriptor", () => {
  assert.equal(undoLabel("addToCart"), "Undo add to cart");
  assert.equal(undoLabel("remove_item"), "Undo remove item");
  assert.deepEqual(navigateBackRewind(), { kind: "navigate-back", label: "Go back" });
});
