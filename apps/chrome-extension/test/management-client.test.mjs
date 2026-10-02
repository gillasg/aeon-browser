import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import test from "node:test";

test("management uses one lazy scoped connection and reacquires it after close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pippin-management-client-"));
  try {
    const outfile = join(directory, "client.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/management-client.ts", import.meta.url))],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "native-fixture",
          setup(builder) {
            builder.onResolve({ filter: /native-ui-client\.js$/ }, () => ({
              path: "native-fixture",
              namespace: "fixture",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents:
                "export async function connectNativeUi(scope){return globalThis.__pippinManagementConnect(scope)}",
              loader: "js",
            }));
          },
        },
      ],
    });
    const { createManagementClient } = await import(pathToFileURL(outfile).href);
    let calls = 0;
    const clients = [];
    globalThis.__pippinManagementConnect = async (scope) => {
      assert.deepEqual(scope, { kind: "management" });
      calls++;
      const client = { socket: new globalThis.EventTarget() };
      clients.push(client);
      return { kind: "connected", client };
    };
    const catalog = { catalog: true };
    const getClient = createManagementClient(true, () => catalog);
    assert.equal(calls, 0);
    const [first, second] = await Promise.all([getClient(), getClient()]);
    assert.equal(first, second);
    assert.equal(calls, 1);
    first.socket.dispatchEvent(new globalThis.Event("close"));
    assert.equal(await getClient(), clients[1]);
    assert.equal(calls, 2);
    await verifyRetry(getClient, clients);
    assert.equal(calls, 3);
    assert.equal(await createManagementClient(false, () => catalog)(), catalog);
    assert.equal(calls, 3);
  } finally {
    delete globalThis.__pippinManagementConnect;
    await rm(directory, { recursive: true, force: true });
  }
});

async function verifyRetry(getClient, clients) {
  clients[1].socket.dispatchEvent(new globalThis.Event("close"));
  const connect = globalThis.__pippinManagementConnect;
  globalThis.__pippinManagementConnect = async () => {
    throw new Error("Temporary connect failure");
  };
  await assert.rejects(getClient(), /Temporary connect failure/);
  globalThis.__pippinManagementConnect = connect;
  assert.equal(await getClient(), clients[2]);
}
