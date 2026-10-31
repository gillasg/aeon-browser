import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ERROR_CODES } from "@browserkit/protocol";
import { EFFECTS, checkDeclared, effectErrors, effectsHelp } from "../dist/kernel-effects.js";

const source = readFileSync(new URL("../src/code-runtime-effects.ts", import.meta.url), "utf8");
const implemented = [...source.matchAll(/name: "([a-zA-Z.]+)"/g)].map((match) => match[1]);

test("every effect the runtime defines is declared, and every declaration is implemented", () => {
  assert.deepEqual([...implemented].sort(), EFFECTS.map((doc) => doc.name).sort());
});

test("declared errors come from the closed set", () => {
  for (const doc of EFFECTS)
    for (const code of effectErrors(doc))
      assert.ok(ERROR_CODES.includes(code), `${doc.name}: ${code}`);
});

test("help('effects') names every effect's call, its needs and its errors", () => {
  const help = effectsHelp();
  for (const doc of EFFECTS) assert.ok(help.includes(`${doc.call}: ${doc.does}.`), doc.name);
  assert.match(
    help,
    /bu\.signIn\(\{account\?\}\): .*Needs a tab this chat may use, on an allowed site\. May raise INVALID_TARGET, TAB_DEAD, SITE_BLOCKED, SIGNED_OUT/,
  );
});

test("the startup check refuses an undeclared, missing or mis-checked effect", () => {
  const real = EFFECTS.map((doc) => ({
    name: doc.name,
    ...(doc.needs.includes("tab") ? { tab: () => 1 } : {}),
    ...(doc.needs.includes("site") ? { site: () => "x" } : {}),
  }));
  checkDeclared(real);
  assert.throws(() => checkDeclared([...real, { name: "page.new" }]), /not declared/);
  assert.throws(() => checkDeclared(real.slice(1)), /not implemented: secret.forbidden/);
  const unguarded = real.map((effect) =>
    effect.name === "net.fetch" ? { name: effect.name } : effect,
  );
  assert.throws(() => checkDeclared(unguarded), /net.fetch does not check what it declares/);
});
