import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LibraryActions } from "../dist/library-actions.js";
import { workflowCards } from "../dist/management-library.js";

// The Automations/Sites actions without a browser: the workflow store and the site registry are
// real folders, the code runner is a stub that records what it was asked to run.

async function home() {
  const root = await mkdtemp(join(tmpdir(), "aeon-library-"));
  process.env.BROWSERKIT_HOME = join(root, "browserkit");
  process.env.SITE_TO_API_HOME = join(root, "sites");
  return root;
}

function definition(name) {
  return { name, steps: [{ id: "open", do: "goto", with: { url: "https://example.com" } }] };
}

test("a workflow is imported, listed and exported as a file", async () => {
  const root = await home();
  const calls = [];
  const actions = new LibraryActions(async (code) => {
    calls.push(code);
    return { ok: true };
  });
  await actions.execute("import_workflow", { json: JSON.stringify(definition("Daily check")) });
  const cards = await workflowCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, "Daily check");
  assert.equal(cards[0].steps, 1);

  await actions.execute("export_workflow", { name: "Daily check" });
  const exported = join(root, "browserkit", "exports", "daily-check.json");
  const parsed = JSON.parse(await readFile(exported, "utf8"));
  assert.equal(parsed.workflow.name, "Daily check");
});

test("clearing a site session removes its file and the site's cookies", async () => {
  await home();
  const site = "shop.example";
  const dir = join(process.env.SITE_TO_API_HOME, "sites", site);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.json"), JSON.stringify({ site }), "utf8");
  const calls = [];
  const actions = new LibraryActions(async (code) => {
    calls.push(code);
    return { cleared: true };
  });
  await actions.execute("clear_site_session", { site });
  await assert.rejects(readFile(join(dir, "session.json"), "utf8"), /ENOENT/);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /cookies\.clear/);
  assert.match(calls[0], /shop\.example/);
});

test("a run's browser actions become workflow steps", async () => {
  const { workflowFromActions } = await import("../dist/library-actions.js");
  const definition = workflowFromActions("From a run", [
    { op: "openTab", url: "https://shop.example/" },
    { op: "click", element: { kind: "locator", role: "button", name: "Buy" } },
    { op: "fill", element: { kind: "query", by: "css", value: "#q" }, value: "lamp" },
    { op: "press", key: "Enter" },
    { op: "observe" },
  ]);
  assert.equal(definition.name, "From a run");
  assert.deepEqual(
    definition.steps.map((step) => step.do),
    ["goto", "click", "fill", "press"],
  );
  assert.deepEqual(definition.steps[1].with, { role: "button", name: "Buy" });
  assert.deepEqual(definition.steps[2].with, { css: "#q", value: "lamp" });
  await assert.rejects(async () => workflowFromActions("Empty", []), /no browser actions/);
});
