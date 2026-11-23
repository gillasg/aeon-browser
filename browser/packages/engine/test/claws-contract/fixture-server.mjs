// A loopback-only HTTP fixture server for the Claw contract suite. It never binds a public
// address and never calls out, so a contract run is deterministic and offline by construction.
import { createServer } from "node:http";

const PAGE = "<!doctype html><title>fixture</title><p>contract fixture</p>";

/** Echoes the request back as JSON: the headers it sent and the path it asked for. */
function route(req, res) {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/echo") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, headers: req.headers }));
    return;
  }
  if (path === "/page") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

/** Starts the server on 127.0.0.1 with an ephemeral port. `close()` resolves once it stops. */
export async function startFixtureServer() {
  const server = createServer(route);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
