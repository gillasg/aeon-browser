import assert from "node:assert/strict";
import test from "node:test";
import { rankPalette } from "../dist/command-palette.js";

const item = (label, hint = "") => ({ id: label, label, hint, run() {} });

test("the palette keeps items that contain every word, best match first", () => {
  const items = [
    item("Open sites", "Go"),
    item("Check price", "shop.example"),
    item("Price drop", "x"),
  ];
  assert.deepEqual(
    rankPalette(items, "price").map((entry) => entry.label),
    ["Price drop", "Check price"],
  );
  assert.deepEqual(
    rankPalette(items, "price shop").map((entry) => entry.label),
    ["Check price"],
  );
  assert.equal(rankPalette(items, "").length, 3);
});
