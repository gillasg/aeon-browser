import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("shared UI styles reference defined Pippin design tokens", async () => {
  const paths = [
    "../chat.css",
    "../home.css",
    "../sidepanel.css",
    "../../../packages/ui/src/tokens.css",
  ];
  const styles = (
    await Promise.all(paths.map((path) => readFile(new URL(path, import.meta.url), "utf8")))
  ).join("\n");
  const defined = new Set([...styles.matchAll(/(--pippin-[\w-]+)\s*:/g)].map((match) => match[1]));
  const used = new Set([...styles.matchAll(/var\((--pippin-[\w-]+)/g)].map((match) => match[1]));
  assert.deepEqual(
    [...used].filter((name) => !defined.has(name)),
    [],
  );
});
