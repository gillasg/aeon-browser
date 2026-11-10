// The sandbox runtime is JavaScript kept in template strings. A `'\n'` written inside one becomes
// a raw newline in a string literal, the joined source stops parsing, and every cell hangs until
// its deadline. Parse the same joined source the sandbox evaluates, in the same order.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sandbox = readFileSync(new URL("../src/code-sandbox.ts", import.meta.url), "utf8");

async function sandboxParts() {
  const from = new Map();
  for (const match of sandbox.matchAll(/import \{([^}]+)\} from "\.\/([\w-]+)\.js";/g)) {
    for (const name of match[1].split(",").map((part) => part.trim()))
      if (name) from.set(name, match[2]);
  }
  const list = /evaluate\(\s*\[([\s\S]*?)\]\.join/.exec(sandbox);
  assert.ok(list, "code-sandbox.ts evaluates a joined list of runtime parts");
  const names = list[1].split(",").map((part) => part.trim()).filter(Boolean);
  const parts = [];
  for (const name of names) {
    const file = from.get(name);
    assert.ok(file, `${name} is imported from a local module`);
    const module = await import(`../dist/${file}.js`);
    assert.equal(typeof module[name], "string", `${name} is runtime source`);
    parts.push({ name, source: module[name] });
  }
  return parts;
}

test("every sandbox runtime part parses, alone and joined in sandbox order", async () => {
  const parts = await sandboxParts();
  assert.ok(parts.length > 10);
  for (const { name, source } of parts) {
    assert.doesNotThrow(() => new vm.Script(source, { filename: name }), `${name} parses`);
  }
  const joined = parts.map((part) => part.source).join("\n");
  assert.doesNotThrow(() => new vm.Script(joined, { filename: "sandbox" }));
});
