// graft compile's output: a zero-dependency typed client that calls the local REST server with a
// client token, pages with async iterators, and refuses writes the page has not proven.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  generateStandaloneClient,
  loadModel,
  operationDeclaration,
  rebuild,
  saveFlow,
  serve,
  siteName,
} from "../dist/index.js";
import { startFixtureSite } from "./fixture-site.mjs";
import { browseShop, tempHome } from "./helpers.mjs";

test("the standalone client imports nothing, types its ops, and calls graft rest", async (t) => {
  await tempHome(t);
  const site = await startFixtureSite();
  t.after(() => site.close());
  const name = siteName(site.origin);
  await saveFlow(
    name,
    { name: "shop", recordedAt: new Date().toISOString() },
    (await browseShop(site.origin)).har(),
  );
  await rebuild(name);
  const model = await loadModel(name);
  const client = generateStandaloneClient(model);
  assert.doesNotMatch(client.source, /^\s*import\s/m, "zero imports");
  assert.doesNotMatch(client.source, /browserkit|site-mapper/, "no frozen package names");
  assert.match(client.declarations, /listProducts\(params\?: ListProductsParams\)/);
  assert.match(client.declarations, /export declare function create\w+Api/);
  assert.ok(client.firstRead);
  assert.match(operationDeclaration(model, "listProducts"), /declare function listProducts/);

  // A write the recordings never saw succeed is guarded.
  const unproven = {
    ...model,
    operations: [
      ...model.operations,
      { ...model.operations[0], id: "deleteAll", role: "action", method: "POST", samples: [] },
    ],
  };
  const guarded = generateStandaloneClient(unproven);
  assert.match(guarded.source, /NOT_PROVEN/);

  const server = await serve({
    transport: "direct",
    session: false,
    authorize: (token) => token === "graft_mcp_client",
  });
  t.after(() => server.close());
  const dir = await mkdtemp(join(tmpdir(), "standalone-client-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const js = ts.transpileModule(guarded.source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = join(dir, "client.mjs");
  await writeFile(file, js);
  const module = await import(pathToFileURL(file).href);
  const create = Object.values(module).find((value) => typeof value === "function");
  const api = create({ baseUrl: server.url, token: "graft_mcp_client" });
  const list = await api.listProducts({ limit: 2 });
  assert.equal(list.items.length, 2);
  await assert.rejects(api.deleteAll({}), /NOT_PROVEN/);
  const denied = create({ baseUrl: server.url, token: "graft_mcp_wrong" });
  await assert.rejects(denied.listProducts({ limit: 1 }), /x-site-to-api-token|401/);
  if (api.paginate.listProducts) {
    const seen = [];
    for await (const item of api.paginate.listProducts({ limit: 2 })) {
      seen.push(item);
      if (seen.length >= 5) break;
    }
    assert.ok(seen.length >= 2);
  }
});
