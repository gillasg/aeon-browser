#!/usr/bin/env node
// The anti-slop taste linter over both director cuts. Exit 1 on any failure.
import { formatLint, lintEdit } from "../src/lint.ts";
import { loadEdits } from "./load-edit.mjs";

const { edits } = loadEdits(process.argv[2], process.argv[3]);
let ok = true;
for (const [name, edit] of Object.entries(edits)) {
  const result = lintEdit(edit);
  ok &&= result.ok;
  console.log(`${name}: ${formatLint(result).split("\n").join(`\n${name}: `)}`);
}
process.exit(ok ? 0 : 1);
