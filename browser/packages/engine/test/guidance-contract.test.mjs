// Every runtime call the agent text names must exist in the runtime: guidance can never promise
// a method the engine does not have (the drift that sent agents to calls that throw).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const engine = join(here, "..");
const browserRoot = join(engine, "..", "..");
const repo = join(browserRoot, "..");

function read(path) {
  return readFileSync(path, "utf8");
}

/** The runtime's source: every code-api module (they hold the realm's code as strings). */
function runtimeSource() {
  const src = join(engine, "src");
  return readdirSync(src)
    .filter((name) => /^code-api.*\.ts$/.test(name) && name !== "code-api-help.ts")
    .map((name) => read(join(src, name)))
    .join("\n");
}

/** What the agent reads: shared sections, tool guidance, primer, Aeon-only parts, help topics. */
function agentText() {
  const docs = join(browserRoot, "docs", "agent");
  const sections = join(docs, "sections");
  const parts = join(repo, "skills", "aeon", "parts");
  return [
    ...readdirSync(sections).map((name) => read(join(sections, name))),
    read(join(docs, "guidance.md")),
    read(join(docs, "primer-browserkit.md")),
    ...readdirSync(parts).map((name) => read(join(parts, name))),
    read(join(repo, "packages", "pi-adapter", "guidance-extra.md")),
    read(join(engine, "src", "code-api-help.ts")),
  ].join("\n");
}

// Names the text uses for something other than a runtime method (a result field, an option,
// a page's own JS, a CLI word).
const NOT_METHODS = new Set(["example", "com", "md", "json", "ts", "js", "in", "co"]);

function namedCalls(text) {
  const found = new Map();
  const pattern = /\b(page|browser|bu|site|siteMapper)\.([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[2];
    if (NOT_METHODS.has(name)) continue;
    const key = `${match[1]}.${name}`;
    if (!found.has(key)) found.set(key, name);
  }
  return found;
}

function defined(source, name) {
  const escaped = name.replace(/\$/g, "\\$");
  return new RegExp(
    `(^|[\\s,{(])['"]?${escaped}['"]?\\s*:|\\.${escaped}\\s*=|\\b${escaped}\\s*\\([^()]*\\)\\s*\\{|function\\s+${escaped}\\b`,
    "m",
  ).test(source);
}

test("every runtime call named in the agent text exists in the runtime", () => {
  const source = runtimeSource();
  const missing = [...namedCalls(agentText())]
    .filter(([, name]) => !defined(source, name))
    .map(([call]) => call);
  assert.deepEqual(missing, [], `agent text names calls the runtime lacks: ${missing.join(", ")}`);
});

test("the agent text never tells the agent to attach a tab before using it", () => {
  assert.doesNotMatch(agentText(), /attach (it|a tab|the tab) first/i);
});

test("every error code named in the agent text is one the engine can raise", () => {
  // Codes come from errors.ts, sign-in reasons from the engine and the credentials package.
  const errors = ["protocol", "engine", "credentials"]
    .map((pkg) => join(browserRoot, "packages", pkg, "src"))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".ts") && name !== "code-api-help.ts")
        .map((name) => read(join(dir, name))),
    )
    .join("\n");
  const codes = new Set(
    [...agentText().matchAll(/`([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+)`|\b([A-Z]+_[A-Z_]{3,})\b/g)].map(
      (match) => match[1] ?? match[2],
    ),
  );
  codes.delete("HELP_TOPICS"); // the help file's own export name
  const missing = [...codes].filter((code) => !errors.includes(code));
  assert.deepEqual(
    missing,
    [],
    `agent text names codes the engine never raises: ${missing.join(", ")}`,
  );
});
