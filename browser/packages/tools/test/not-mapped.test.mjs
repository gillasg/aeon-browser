import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { namedErrorText } from "../dist/definitions.js";

test("an unmapped site names the explore call that learns it", () => {
  const text = namedErrorText(new Error("amazon.in has no API yet"));
  assert.match(text, /^NOT_MAPPED/);
  assert.match(text, /site_mapper\(\{action:"explore", sites:\["amazon\.in"\]\}\)/);
  const source = readFileSync(new URL("../src/definitions.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /site_mapper\(\{action:"explore", sites:\[\$\{JSON\.stringify\(site\)\}\]\}\)/,
  );
});
