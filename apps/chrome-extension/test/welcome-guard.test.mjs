import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/manage-tab.ts", import.meta.url), "utf8");

test("the welcome tab opens on install only, and can be switched off", () => {
  assert.match(source, /reason === "install" && disabled !== true && !automated/);
  assert.match(source, /welcome\.html/);
});
