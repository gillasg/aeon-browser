// A stand-in Graft daemon for CLI tests: writes core-connection.json into a data dir and answers
// the handshake and the few requests `graft record` makes, with empty results.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const RESULTS = {
  "core.settings": { kind: "core.settings.result", browsers: [] },
  "core.film": { kind: "core.film.result", ok: true, beats: [] },
  "core.browser.run": { kind: "core.browser.result", value: [] },
};

export async function startFakeDaemon(dataDir) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((done) => server.once("listening", done));
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.kind === "core.hello") return socket.send(JSON.stringify({ kind: "core.ready" }));
      const reply = RESULTS[message.kind];
      if (reply && message.requestId)
        socket.send(JSON.stringify({ ...reply, requestId: message.requestId }));
    });
  });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "core-connection.json"),
    JSON.stringify({ endpoint: `ws://127.0.0.1:${server.address().port}`, token: "test" }),
  );
  return { close: () => new Promise((done) => server.close(done)) };
}
