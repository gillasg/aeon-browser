import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Pages that enforce Trusted Types (Google's sign-in and account pages, among others) throw on
// any HTML-string sink, so an overlay built that way never draws: the cursor, its hand-off pill
// and the control banner went missing exactly where users sign in. Engine code builds page
// nodes with createElement and textContent instead.
const SINKS = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\(|document\.write\(/;

test("engine code never writes HTML strings into pages", () => {
  const dir = join(import.meta.dirname, "..", "packages", "engine", "src");
  const offenders = readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .map((line, index) => ({ name, line: index + 1, text: line }))
        .filter(({ text }) => SINKS.test(text) && !text.trim().startsWith("//")),
    )
    .map(({ name, line, text }) => `${name}:${line}: ${text.trim()}`);
  assert.deepEqual(offenders, []);
});
