import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("shared UI styles reference defined Aeon design tokens", async () => {
  const paths = [
    "../chat.css",
    "../home.css",
    "../sidepanel.css",
    "../pages.css",
    "../../../packages/ui/src/tokens.css",
  ];
  const styles = (
    await Promise.all(paths.map((path) => readFile(new URL(path, import.meta.url), "utf8")))
  ).join("\n");
  const defined = new Set([...styles.matchAll(/(--aeon-[\w-]+)\s*:/g)].map((match) => match[1]));
  const used = new Set([...styles.matchAll(/var\((--aeon-[\w-]+)/g)].map((match) => match[1]));
  assert.deepEqual(
    [...used].filter((name) => !defined.has(name)),
    [],
  );
});
